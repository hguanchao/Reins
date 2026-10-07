import { join } from 'node:path';
import {
  loadCatalogFile,
  resolveAuth,
  resolveModel,
  resolveProvider,
  type ResolvedAuth,
} from '../../catalog/load.ts';
import type { Catalog } from '../../catalog/schema.ts';
import { loadLayeredConfig } from '../../config/layers.ts';
import type { Config } from '../../config/schema.ts';
import { supportedApis } from '../../llm/stream.ts';
import { McpManager } from '../../mcp/servers.ts';
import { absolutize, reinsHome } from '../../util/paths.ts';
import { describeError } from '../../util/errors.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';
import { resolveTrustForCli, trustLine } from '../trust.ts';

/**
 * doctor 子命令:自检配置、目录、模型解析、密钥与端点连通性。
 *
 * 设计意图:把「第一次跑不起来」的各种原因逐项检查并给出可行动的结论;
 * 任一硬性问题都会让退出码为 1,便于脚本化校验。
 */
export async function doctorCommand(args: ParsedArgs, io: CommandIo = defaultIo): Promise<number> {
  const home = reinsHome();
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();
  const skipNetwork = args.flags['no-network'] === true;

  const passes: string[] = [];
  const issues: string[] = [];

  let config: Config | undefined;
  try {
    const resolution = await resolveTrustForCli({
      home,
      workspace,
      force: args.flags['trust'] === true,
      // 自检不提问:它只报告状态,更不该为了看一眼而要求授权
      allowPrompt: false,
      io,
    });
    const layered = await loadLayeredConfig({
      home,
      cwd: workspace,
      projectLayer: resolution.projectAllowed ? 'allow' : 'ignore',
    });
    config = layered.config;
    passes.push(`配置加载成功(${layered.files.join('、')})`);
    // 项目层被忽略是安全相关的状态,必须报出来
    (resolution.projectAllowed ? passes : issues).push(trustLine(resolution));
  } catch (error) {
    issues.push(`配置:${describeError(error)}`);
  }

  let catalog: Catalog | undefined;
  try {
    catalog = await loadCatalogFile(join(home, 'providers.json'));
    passes.push(`产商目录加载成功(${Object.keys(catalog.providers).length} 个 provider)`);
  } catch (error) {
    issues.push(`产商目录:${describeError(error)}`);
  }

  if (config !== undefined && catalog !== undefined) {
    await checkModel(config, catalog, skipNetwork, passes, issues);
  }

  if (config !== undefined && Object.keys(config.mcpServers).length > 0) {
    await checkMcpServers(config, skipNetwork, passes, issues);
  }

  io.out('Reins 自检');
  for (const line of passes) {
    io.out(`  √ ${line}`);
  }
  for (const line of issues) {
    io.out(`  × ${line}`);
  }
  if (issues.length === 0) {
    io.out('一切正常。');
    return 0;
  }
  io.out(`发现 ${issues.length} 个问题。`);
  return 1;
}

async function checkModel(
  config: Config,
  catalog: Catalog,
  skipNetwork: boolean,
  passes: string[],
  issues: string[],
): Promise<void> {
  try {
    const provider = resolveProvider(catalog, config.provider);
    const model = resolveModel(provider, config.provider, config.model);
    passes.push(`模型解析成功:${config.provider}/${model.id}`);

    if (!supportedApis().includes(provider.api)) {
      issues.push(`协议 "${provider.api}" 尚未实现(已实现:${supportedApis().join('、')})`);
    } else {
      passes.push(`协议适配器就绪:${provider.api}`);
    }

    const contextWindow = model.contextWindow ?? config.contextWindow;
    if (contextWindow === undefined) {
      issues.push('模型未声明 contextWindow,且 config.toml 未设置 context_window');
    } else {
      passes.push(`上下文窗口:${contextWindow}`);
    }

    const auth = await resolveAuth(provider, config.provider);
    passes.push(
      auth.apiKey !== undefined ? '密钥解析成功' : '未声明 apiKey,按无鉴权端点处理',
    );

    if (!skipNetwork && /^https?:\/\//.test(provider.baseUrl)) {
      try {
        const status = await probeEndpoint(provider.baseUrl, auth);
        passes.push(`端点连通:HTTP ${status}`);
      } catch (error) {
        issues.push(`端点连通性检查失败:${describeError(error)}`);
      }
    }
  } catch (error) {
    issues.push(describeError(error));
  }
}

async function probeEndpoint(baseUrl: string, auth: ResolvedAuth): Promise<number> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { ...auth.headers };
  if (auth.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${auth.apiKey}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  return response.status;
}

/** 连接被声明的 MCP server,把状态合并进报告;--no-network 时跳过 http 型。 */
async function checkMcpServers(
  config: Config,
  skipNetwork: boolean,
  passes: string[],
  issues: string[],
): Promise<void> {
  const configs = Object.fromEntries(
    Object.entries(config.mcpServers).filter(
      ([, server]) => !skipNetwork || server.type === undefined,
    ),
  );
  const manager = new McpManager(configs);
  try {
    const statuses = await manager.connectAll();
    for (const status of statuses) {
      if (status.ok) {
        passes.push(`MCP ${status.name}:${status.toolCount ?? 0} 个工具`);
      } else {
        issues.push(`MCP ${status.name} 未连接:${status.error ?? '未知原因'}`);
      }
    }
  } finally {
    await manager.close();
  }
}
