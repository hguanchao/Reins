import { dirname, join } from 'node:path';
import { resolveAuth, resolveModel, resolveProvider } from '../catalog/load.ts';
import type { Catalog } from '../catalog/schema.ts';
import type { Config } from '../config/schema.ts';
import { discoverProjectDoc } from '../context/agents-md.ts';
import { buildSystemPrompt } from '../context/system.ts';
import { createAdapter } from '../llm/stream.ts';
import type { AdapterRuntime, ResolvedModel } from '../llm/types.ts';
import { ApprovalGate, type ApprovalGateOptions } from '../permissions/approval.ts';
import { PermissionEngine } from '../permissions/engine.ts';
import { Sandbox } from '../permissions/sandbox.ts';
import { Session } from '../session/tree.ts';
import { SpillStore } from '../spill/store.ts';
import { createDefaultRegistry } from '../tools/defaults.ts';
import type { AgentUi } from '../ui/printer.ts';
import { ConfigError } from '../util/errors.ts';
import { Agent, type AgentRunResult } from './loop.ts';

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
}

export interface RunTaskOutcome {
  session: Session;
  result: AgentRunResult;
}

export async function runTask(prompt: string, options: RunTaskOptions): Promise<RunTaskOutcome> {
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
  const session =
    options.sessionFile !== undefined
      ? await Session.resume(options.sessionFile)
      : await Session.create(join(options.home, 'sessions'), options.workspace);

  const registry = createDefaultRegistry();
  const engine = new PermissionEngine([options.config.permissions], options.config.approval);
  const sandbox = new Sandbox(options.config.sandbox, options.workspace);
  const approval = new ApprovalGate(options.config.approval, options.approval);
  const spill = new SpillStore(join(dirname(session.path), `${session.id}.spill`));

  const projectDoc = await discoverProjectDoc(options.workspace);
  const systemPrompt = buildSystemPrompt({
    workspace: options.workspace,
    model: `${providerName}/${model.id}`,
    projectDoc,
  });

  const runtime: AdapterRuntime = {
    maxRetries: options.config.maxRetries,
    proxy: options.config.proxy,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
  };

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
  });

  const result = await agent.run(prompt);
  return { session, result };
}
