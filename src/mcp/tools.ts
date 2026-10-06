import type { Tool, ToolRegistry } from '../tools/registry.ts';
import type { McpManager, McpToolEntry } from './servers.ts';

/**
 * MCP 工具桥接:把远端工具包装为内置工具协议。
 *
 * 设计意图:命名统一为 mcp__<server>__<tool> 避免与内置工具冲突;
 * 权限规则统一归到 "mcp" 工具名,用 `mcp(server)` 表达(见 ruleToolName)。
 */
export class McpTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly permissionKind = 'mcp' as const;
  readonly ruleToolName = 'mcp';
  private readonly manager: McpManager;
  private readonly server: string;
  private readonly remoteName: string;

  constructor(manager: McpManager, server: string, tool: McpToolEntry['tool']) {
    this.manager = manager;
    this.server = server;
    this.remoteName = tool.name;
    this.name = `mcp__${sanitize(server)}__${sanitize(tool.name)}`;
    this.description = tool.description ?? `MCP 工具(${server}/${tool.name})`;
    this.parameters = tool.inputSchema ?? { type: 'object' };
  }

  targetOf() {
    return { server: this.server };
  }

  async execute(input: Record<string, unknown>) {
    const result = await this.manager.callTool(this.server, this.remoteName, input);
    return { content: result.text, isError: result.isError };
  }
}

/** 把已连接 server 的工具注册进注册表。 */
export function registerMcpTools(registry: ToolRegistry, manager: McpManager): void {
  for (const entry of manager.listTools()) {
    registry.register(new McpTool(manager, entry.server, entry.tool));
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}
