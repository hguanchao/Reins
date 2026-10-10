import { ConfigError } from '../util/errors.ts';
import { expandHome, isAbsoluteLike, normalizeSlashes } from '../util/paths.ts';
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

/** 判断一个字符串是否是合法的思考强度档位;配置解析与 /effort 共用这一份口径。 */
export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * 把用户输入解析为档位:精确命中直接采纳,否则取唯一前缀命中(如 x → xhigh)。
 *
 * 前缀有歧义(m 同时命中 medium 与 max)或无人命中时返回 undefined,交由调用方报错。
 */
export function resolveReasoningEffort(value: string): ReasoningEffort | undefined {
  if (isReasoningEffort(value)) {
    return value;
  }
  const matches = REASONING_EFFORTS.filter((level) => level.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

/** 主题预设:只切换配色方案,具体取值固定定义在 tui/theme.ts。 */
export const THEME_PRESETS = ['dark', 'light', 'mono'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

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
  theme?: ThemePreset;
}

/**
 * 目录信任:命中 trusted 里某个目录模式,才加载那个目录的 .reins/config.toml
 * 与 REINS.md/AGENTS.md。
 *
 * 只从全局层读取——项目层不得声明本节点,否则仓库可以给自己授权。
 */
export interface TrustConfig {
  /** 路径模式:绝对路径,或 ~/ 开头;支持 * 与 **(不跨目录的回退匹配)。 */
  trusted: string[];
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
  trust: TrustConfig;
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
  const theme = checker.string(uiTable, 'theme', 'ui.theme', { values: THEME_PRESETS });
  // 主题颜色已全局固定;显式报错而不是静默忽略,否则用户改了颜色却看不到任何反馈
  if (uiTable['colors'] !== undefined) {
    checker.fail('ui.colors', '已移除:主题颜色全局固定、不可配置,请删除该小节');
  }

  const mcpServers = parseMcpServers(source, checker);
  const trust = parseTrust(source, checker);

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
    ui: {
      notify: (notify as NotifyMode | undefined) ?? 'auto',
      theme: theme as ThemePreset | undefined,
    },
    trust,
    mcpServers,
  };
}

/**
 * 校验 [trust]:trusted 必须是路径模式数组,且每项展开后是绝对路径。
 *
 * 要求绝对路径是为了挡掉过宽的模式:不含分隔符的写法(如 "Reins")会匹配任意
 * 同名目录,而信任是"把这个目录交给仓库自己管"的授权,不能这么松。
 */
function parseTrust(source: Record<string, unknown>, checker: Checker): TrustConfig {
  const table = checker.object(source, 'trust', 'trust') ?? {};
  const list = checker.stringArray(table, 'trusted', 'trust.trusted') ?? [];
  const trusted: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const pattern = list[index] as string;
    if (!isAbsoluteLike(normalizeSlashes(expandHome(pattern.trim())))) {
      checker.fail(
        `trust.trusted[${index}]`,
        `应为绝对路径或 ~/ 开头的模式,实际为 "${pattern}"`,
      );
      continue;
    }
    trusted.push(pattern);
  }
  return { trusted };
}

function parseMcpServers(
  source: Record<string, unknown>,
  checker: Checker,
): Record<string, McpServerConfig> {  const table = checker.object(source, 'mcp_servers', 'mcp_servers') ?? {};
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
