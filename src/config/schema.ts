import { ConfigError } from '../util/errors.ts';
import { Checker } from '../util/schema.ts';

/**
 * config.toml 的形状定义与校验。
 *
 * 设计意图:配置键与「属主模块」一一对应(见架构文档);
 * 校验阶段一次性收集全部问题,并给出可读的字段路径。
 */

export type ApprovalMode = 'ask' | 'auto' | 'yolo';
export type SandboxMode = 'off' | 'workspace' | 'read-only';
export type NotifyMode = 'auto' | 'bell' | 'desktop' | 'off';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'auto', 'yolo'];
export const SANDBOX_MODES: readonly SandboxMode[] = ['off', 'workspace', 'read-only'];
export const NOTIFY_MODES: readonly NotifyMode[] = ['auto', 'bell', 'desktop', 'off'];
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 长期权限规则:跨层按 deny > ask > allow 求值,先命中先定论。 */
export interface PermissionRules {
  deny: string[];
  ask: string[];
  allow: string[];
}

/** 一个 MCP server 的声明;仅含 disabled 的条目用于禁用外部同名 server。 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  callTimeoutMs?: number;
  disabled?: boolean;
}

export interface UiConfig {
  notify: NotifyMode;
}

export interface Config {
  provider: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  maxRetries: number;
  proxy?: string;
  compactModel?: string;
  reviewModel?: string;
  approval: ApprovalMode;
  sandbox: SandboxMode;
  permissions: PermissionRules;
  maxTurns?: number;
  spillThreshold: number;
  ui: UiConfig;
  mcpServers: Record<string, McpServerConfig>;
}

export const DEFAULT_MAX_RETRIES = 10;
export const DEFAULT_SPILL_THRESHOLD = 8192;

/** 解析并校验原始对象(来自 TOML 或测试);所有问题一次性汇总抛出。 */
export function parseConfig(raw: unknown, file = 'config.toml'): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${file} 的顶层结构应为键值表`, '配置文件应为 TOML 键值对。');
  }
  const source = raw as Record<string, unknown>;
  const checker = new Checker(file);

  const provider = checker.string(source, 'provider', 'provider', { required: true });
  const model = checker.string(source, 'model', 'model', { required: true });
  const contextWindow = checker.number(source, 'context_window', 'context_window', {
    integer: true,
    min: 1,
  });
  const maxTokens = checker.number(source, 'max_tokens', 'max_tokens', { integer: true, min: 1 });
  const reasoningEffort = checker.string(source, 'reasoning_effort', 'reasoning_effort', {
    values: REASONING_EFFORTS,
  });
  const maxRetries = checker.number(source, 'max_retries', 'max_retries', {
    integer: true,
    min: 0,
  });
  const proxy = checker.string(source, 'proxy', 'proxy');
  const compactModel = checker.string(source, 'compact_model', 'compact_model');
  const reviewModel = checker.string(source, 'review_model', 'review_model');
  const approval = checker.string(source, 'approval', 'approval', { values: APPROVAL_MODES });
  const sandbox = checker.string(source, 'sandbox', 'sandbox', { values: SANDBOX_MODES });
  const maxTurns = checker.number(source, 'max_turns', 'max_turns', { integer: true, min: 1 });
  const spillThreshold = checker.number(source, 'spill_threshold', 'spill_threshold', {
    integer: true,
    min: 0,
  });

  const permissionsTable = checker.object(source, 'permissions', 'permissions') ?? {};
  const deny = checker.stringArray(permissionsTable, 'deny', 'permissions.deny') ?? [];
  const ask = checker.stringArray(permissionsTable, 'ask', 'permissions.ask') ?? [];
  const allow = checker.stringArray(permissionsTable, 'allow', 'permissions.allow') ?? [];

  const uiTable = checker.object(source, 'ui', 'ui') ?? {};
  const notify = checker.string(uiTable, 'notify', 'ui.notify', { values: NOTIFY_MODES });

  const mcpServers = parseMcpServers(source, checker);

  checker.done();

  return {
    provider: provider as string,
    model: model as string,
    contextWindow,
    maxTokens,
    reasoningEffort: reasoningEffort as ReasoningEffort | undefined,
    maxRetries: maxRetries ?? DEFAULT_MAX_RETRIES,
    proxy,
    compactModel,
    reviewModel,
    approval: (approval as ApprovalMode | undefined) ?? 'ask',
    sandbox: (sandbox as SandboxMode | undefined) ?? 'off',
    permissions: { deny, ask, allow },
    maxTurns,
    spillThreshold: spillThreshold ?? DEFAULT_SPILL_THRESHOLD,
    ui: { notify: (notify as NotifyMode | undefined) ?? 'auto' },
    mcpServers,
  };
}

function parseMcpServers(
  source: Record<string, unknown>,
  checker: Checker,
): Record<string, McpServerConfig> {
  const table = checker.object(source, 'mcp_servers', 'mcp_servers') ?? {};
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(table)) {
    const path = `mcp_servers.${name}`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      checker.fail(path, `应为对象,实际为 ${Array.isArray(value) ? '数组' : typeof value}`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const command = checker.string(entry, 'command', `${path}.command`);
    const args = checker.stringArray(entry, 'args', `${path}.args`);
    const type = checker.string(entry, 'type', `${path}.type`, { values: ['http', 'sse'] });
    const url = checker.string(entry, 'url', `${path}.url`);
    const headers = checker.stringMap(entry, 'headers', `${path}.headers`);
    const callTimeoutMs = checker.number(entry, 'call_timeout_ms', `${path}.call_timeout_ms`, {
      integer: true,
      min: 1,
    });
    const disabled = checker.boolean(entry, 'disabled', `${path}.disabled`);

    const hasTransport = command !== undefined || url !== undefined || type !== undefined;
    if (!hasTransport && disabled === undefined) {
      checker.fail(path, '需要声明 command(stdio)或 type + url(http/sse);或仅声明 disabled 以禁用外部同名 server');
    }
    if ((type === 'http' || type === 'sse') && url === undefined) {
      checker.fail(path, `type = "${type}" 时必须声明 url`);
    }
    if (url !== undefined && type === undefined) {
      checker.fail(path, '声明了 url 时必须同时声明 type = "http" 或 "sse"');
    }

    servers[name] = {
      command,
      args,
      type: type as 'http' | 'sse' | undefined,
      url,
      headers,
      callTimeoutMs,
      disabled,
    };
  }
  return servers;
}
