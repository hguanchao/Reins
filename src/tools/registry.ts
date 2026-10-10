import type { ToolSpec } from '../llm/types.ts';
import { ToolError } from '../util/errors.ts';

/**
 * 工具注册表与工具契约。
 *
 * 设计意图:每个工具自描述(名称、说明、参数模式、权限类别、匹配目标),
 * 注册表只做聚合与查找;工具实现互不认识,新增工具零侵入。
 */

export interface ToolContext {
  workspace: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export type PermissionKind = 'path-read' | 'path-write' | 'bash' | 'network' | 'mcp';

export interface ToolInvocationTarget {
  path?: string;
  command?: string;
  domain?: string;
  server?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly permissionKind: PermissionKind;
  /** 规则匹配使用的工具名;默认用 name(MCP 工具统一用 "mcp")。 */
  readonly ruleToolName?: string;
  /** 从模型输入中提取规则匹配目标(路径/命令等)。 */
  targetOf(input: Record<string, unknown>, ctx: ToolContext): ToolInvocationTarget;
  /**
   * 审批前预览:把这次调用的改动摊成几行给人看。
   *
   * 审批批的是「这个改动」而不是一条路径,所以由工具自己给出——它最懂自己的参数。
   * 返回 undefined 表示没什么可预览的。
   */
  previewOf?(input: Record<string, unknown>, ctx: ToolContext): string[] | undefined;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(`工具重名:${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  toToolSpecs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

/** 读取必填非空字符串参数。 */
export function requireString(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`工具 ${toolName} 的参数 "${key}" 缺失或不是非空字符串`);
  }
  return value;
}

/** 读取必填字符串参数(允许空串,例如写入空文件)。 */
export function requireStringAllowEmpty(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new ToolError(`工具 ${toolName} 的参数 "${key}" 缺失或不是字符串`);
  }
  return value;
}

/** 读取可选数字参数。 */
export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ToolError(`工具 ${toolName} 的参数 "${key}" 应为数字`);
  }
  return value;
}

/** 读取可选字符串参数。 */
export function optionalString(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ToolError(`工具 ${toolName} 的参数 "${key}" 应为字符串`);
  }
  return value;
}
