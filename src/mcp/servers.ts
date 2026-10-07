import type { McpServerConfig } from '../config/schema.ts';
import { ReinsError, describeError } from '../util/errors.ts';
import { VERSION } from '../util/version.ts';
import {
  HttpTransport,
  McpClient,
  SseTransport,
  StdioTransport,
  type McpCallResult,
  type McpToolDefinition,
  type McpTransport,
} from './client.ts';

/**
 * MCP 管理器:按配置连接多个 server,汇总工具,转发调用。
 *
 * 设计意图:连接失败只记录状态、绝不阻断启动;调用失败抛出可读错误,
 * 由工具层转成回传模型的结果文本。
 */

export interface McpServerStatus {
  name: string;
  ok: boolean;
  error?: string;
  toolCount?: number;
}

export interface McpToolEntry {
  server: string;
  tool: McpToolDefinition;
}

interface ConnectedServer {
  client: McpClient;
  tools: McpToolDefinition[];
}

export class McpManager {
  private readonly configs: Record<string, McpServerConfig>;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly clients = new Map<string, ConnectedServer>();
  private readonly statusList: McpServerStatus[] = [];

  constructor(
    configs: Record<string, McpServerConfig>,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.configs = configs;
    this.fetchImpl = options.fetchImpl;
  }

  /** 并行连接全部声明的 server;返回每台的状态。 */
  async connectAll(): Promise<McpServerStatus[]> {
    await Promise.all(Object.keys(this.configs).map((name) => this.connectOne(name)));
    return this.statusList;
  }

  /** 已连接 server 的全部工具。 */
  listTools(): McpToolEntry[] {
    const entries: McpToolEntry[] = [];
    for (const [server, connected] of this.clients) {
      for (const tool of connected.tools) {
        entries.push({ server, tool });
      }
    }
    return entries;
  }

  /** 调用指定 server 上的工具。 */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const connected = this.clients.get(server);
    if (connected === undefined) {
      throw new ReinsError('mcp', `MCP server 未连接:${server}`);
    }
    return await connected.client.callTool(tool, args);
  }

  /** 关闭全部连接。 */
  async close(): Promise<void> {
    for (const connected of this.clients.values()) {
      await connected.client.close().catch(() => undefined);
    }
    this.clients.clear();
  }

  private async connectOne(name: string): Promise<void> {
    const config = this.configs[name];
    if (config === undefined || config.disabled === true) {
      return;
    }
    try {
      const client = new McpClient(buildTransport(name, config, this.fetchImpl), {
        callTimeoutMs: config.callTimeoutMs,
      });
      await client.initialize('reins', VERSION);
      const tools = await client.listTools();
      this.clients.set(name, { client, tools });
      this.statusList.push({ name, ok: true, toolCount: tools.length });
    } catch (error) {
      this.statusList.push({ name, ok: false, error: describeError(error) });
    }
  }
}

function buildTransport(
  name: string,
  config: McpServerConfig,
  fetchImpl: typeof fetch | undefined,
): McpTransport {
  if (config.type === 'http') {
    if (config.url === undefined) {
      throw new ReinsError('mcp', `MCP server "${name}" 缺少 url`);
    }
    return new HttpTransport(config.url, config.headers ?? {}, fetchImpl);
  }
  if (config.type === 'sse') {
    if (config.url === undefined) {
      throw new ReinsError('mcp', `MCP server "${name}" 缺少 url`);
    }
    return new SseTransport(config.url, config.headers ?? {}, fetchImpl);
  }
  if (config.command === undefined) {
    throw new ReinsError('mcp', `MCP server "${name}" 缺少 command`);
  }
  return new StdioTransport(config.command, config.args ?? []);
}
