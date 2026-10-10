import { join } from 'node:path';
import { resolveAuth, resolveModel, resolveProvider } from '../catalog/load.ts';
import type { Catalog, ModelSpec, ProviderSpec } from '../catalog/schema.ts';
import type { ApprovalMode, Config } from '../config/schema.ts';
import { discoverProjectDoc } from '../context/agents-md.ts';
import { buildSystemPrompt } from '../context/system.ts';
import { createAdapter } from '../llm/stream.ts';
import type { AdapterRuntime, ResolvedModel } from '../llm/types.ts';
import { McpManager, type McpServerStatus } from '../mcp/servers.ts';
import { registerMcpTools } from '../mcp/tools.ts';
import { ApprovalGate, type ApprovalGateOptions } from '../permissions/approval.ts';
import { PermissionEngine } from '../permissions/engine.ts';
import { Sandbox } from '../permissions/sandbox.ts';
import { Session } from '../session/tree.ts';
import { SpillStore, spillDirFor } from '../spill/store.ts';
import { createDefaultRegistry } from '../tools/defaults.ts';
import { resolveRealPath } from '../tools/realpath.ts';
import type { AgentUi } from '../ui/printer.ts';
import { ConfigError } from '../util/errors.ts';
import { createCompactor } from './compactor.ts';
import { Agent, type AgentRunResult } from './loop.ts';
import { createReviewer } from './reviewer.ts';

/**
 * 运行时组装:把配置、目录、会话、工具与权限拼成一个可运行的代理。
 *
 * 设计意图:这里是唯一的「组装点」(组合根),其余模块只接受注入;
 * 端点到模型的解析、密钥解析、适配器选择都发生在此处。
 */

export interface RunTaskOptions {
  config: Config;
  catalog: Catalog;
  workspace: string;
  home: string;
  ui: AgentUi;
  /** 恢复指定会话文件;省略则新建会话。 */
  sessionFile?: string;
  approval?: ApprovalGateOptions;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 工作区目录是否受信任。未信任时不注入 REINS.md/AGENTS.md——它会被写进系统提示词,
   * 而提示词里明确声明「项目指令优先于通用习惯」,所以它和项目配置一样需要先被信任。
   */
  projectTrusted?: boolean;
}

export interface RunTaskOutcome {
  session: Session;
  result: AgentRunResult;
  /** MCP server 连接状态(被禁用的不出现,失败的都在这)。 */
  mcp: McpServerStatus[];
}

/** 长期存活的运行实例:会话与 MCP 连接跨多轮复用,用完必须 close。 */
export interface AgentRuntime {
  agent: Agent;
  session: Session;
  mcp: McpServerStatus[];
  /** 已解析的模型(含上下文窗口):界面展示上下文占用时不必再解析一遍。 */
  model: ResolvedModel;
  /** 会话内切换审批模式(ask / auto / yolo);只影响后续裁决。 */
  setApprovalMode(mode: ApprovalMode): void;
  close(): Promise<void>;
}

/** 组装运行时;调用方负责在结束时 close。 */
export async function createAgentRuntime(options: RunTaskOptions): Promise<AgentRuntime> {
  const providerName = options.config.provider;
  const provider = resolveProvider(options.catalog, providerName);
  const catalogModel = resolveModel(provider, providerName, options.config.model);
  const auth = await resolveAuth(provider, providerName);

  const contextWindow = catalogModel.contextWindow ?? options.config.contextWindow;
  if (contextWindow === undefined) {
    throw new ConfigError(
      `模型 "${options.config.model}" 未声明上下文窗口`,
      '在 providers.json 的模型条目中补充 contextWindow,或在 config.toml 中设置 context_window。',
    );
  }

  const model: ResolvedModel = {
    provider: providerName,
    id: catalogModel.id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    contextWindow,
    maxTokens: catalogModel.maxTokens ?? options.config.maxTokens,
    reasoning: catalogModel.reasoning,
    cost: catalogModel.cost,
    headers: { ...auth.headers, ...(catalogModel.headers ?? {}) },
    apiKey: auth.apiKey,
  };

  const adapter = createAdapter(provider.api);
  const projectTrusted = options.projectTrusted === true;
  const session =
    options.sessionFile !== undefined
      ? await Session.resume(options.sessionFile)
      : await Session.create(join(options.home, 'sessions'), options.workspace, projectTrusted);

  const runtime: AdapterRuntime = {
    maxRetries: options.config.maxRetries,
    proxy: options.config.proxy,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    onRetry: (info) => options.ui.onRetry?.(info),
  };

  const registry = createDefaultRegistry();
  const mcpManager = new McpManager(options.config.mcpServers, { fetchImpl: options.fetchImpl });
  const mcpStatuses = await mcpManager.connectAll();
  // 连接已建立:之后任何一步失败都要把 MCP 连接收掉,否则子进程会泄漏
  try {
    registerMcpTools(registry, mcpManager);
    for (const status of mcpStatuses) {
      if (!status.ok) {
        options.ui.onNotice(`MCP ${status.name} 未连接:${status.error ?? '未知原因'}`);
      }
    }
    const engine = new PermissionEngine([options.config.permissions], options.config.approval);
    // 边界按真实路径判定:工作区自身若被符号链接指向,字面路径与真实路径不同,
    // 拿字面路径当边界会把区内的正常写入误判成越界
    const sandbox = new Sandbox(options.config.sandbox, await resolveRealPath(options.workspace));
    const gateOptions: ApprovalGateOptions = { ...options.approval };
    if (options.config.approval === 'auto' && gateOptions.reviewer === undefined) {
      gateOptions.reviewer = createReviewer({
        adapter,
        runtime,
        model: resolveNamedModel({
          config: options.config,
          provider,
          providerName,
          mainModel: model,
          modelId: options.config.reviewModel,
        }),
      });
    }
    const approval = new ApprovalGate(options.config.approval, gateOptions);
    const compactor = createCompactor({
      adapter,
      runtime,
      model: resolveNamedModel({
        config: options.config,
        provider,
        providerName,
        mainModel: model,
        modelId: options.config.compactModel,
      }),
    });
    const spill = new SpillStore(spillDirFor(session.path, session.id));

    // 未信任的目录不注入说明文件:它与项目配置同源,都来自仓库
    const projectDoc = projectTrusted ? await discoverProjectDoc(options.workspace) : null;
    const systemPrompt = buildSystemPrompt({
      workspace: options.workspace,
      model: `${providerName}/${model.id}`,
      projectDoc,
    });

    const agent = new Agent({
      config: options.config,
      adapter,
      model,
      registry,
      session,
      engine,
      sandbox,
      approval,
      spill,
      ui: options.ui,
      workspace: options.workspace,
      systemPrompt,
      runtime,
      compactor,
    });

    return {
      agent,
      session,
      mcp: mcpStatuses,
      model,
      // 会话内切换审批模式:引擎的兜底裁决与审批门一起换,不重建运行时
      setApprovalMode: (mode) => {
        engine.setApprovalMode(mode);
        approval.setMode(mode);
      },
      close: async () => {
        await mcpManager.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await mcpManager.close().catch(() => undefined);
    throw error;
  }
}

/** 执行一次任务:创建运行时、跑一轮、关闭运行时。 */
export async function runTask(prompt: string, options: RunTaskOptions): Promise<RunTaskOutcome> {
  const runtime = await createAgentRuntime(options);
  try {
    const result = await runtime.agent.run(prompt);
    return { session: runtime.session, result, mcp: runtime.mcp };
  } finally {
    await runtime.close();
  }
}

/** 解析辅助模型(审查、压缩共用):未指定或与主模型同名时复用主模型。 */
function resolveNamedModel(params: {
  config: Config;
  provider: ProviderSpec;
  providerName: string;
  mainModel: ResolvedModel;
  modelId: string | undefined;
}): ResolvedModel {
  const id = params.modelId ?? params.mainModel.id;
  if (id === params.mainModel.id) {
    return params.mainModel;
  }
  const spec = resolveModel(params.provider, params.providerName, id);
  return {
    provider: params.providerName,
    id: spec.id,
    api: params.provider.api,
    baseUrl: params.provider.baseUrl,
    contextWindow:
      spec.contextWindow ?? params.config.contextWindow ?? params.mainModel.contextWindow,
    maxTokens: spec.maxTokens,
    reasoning: spec.reasoning,
    cost: spec.cost,
    headers: params.mainModel.headers,
    apiKey: params.mainModel.apiKey,
  };
}
