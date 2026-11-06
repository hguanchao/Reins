/**
 * 浏览器侧的协议类型。
 *
 * 服务端推送的事件 = 内核 AgentEvent 原样 + 服务端合成的审批事件;会话条目 = 内核
 * SessionEntry 原样。这里只镜像界面消费到的形状,内核类型不进浏览器构建。
 */

/** 审批卡片上的请求;形状与权限模块的 ApprovalRequest 一致。 */
export interface ApprovalRequest {
	tool: string;
	risk: string;
	detail: string;
	summary?: string;
	preview?: string;
	previewLabel?: string;
	saveLabel?: string;
	saveShort?: string;
}

export type ApprovalAnswer = "once" | "always" | "deny";

export type ApprovalMode = "ask" | "auto" | "yolo";

/** 通知方式：auto 只在窗口失焦时提醒，bell 仅终端响铃，desktop 总是弹桌面通知。 */
export type NotifyMode = "auto" | "bell" | "desktop" | "off";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
	provider: string;
	model: string;
	name: string;
}

export interface SessionSummary {
	id: string;
	title: string | undefined;
	updatedAt: string;
	cwd?: string;
	/** null/undefined 表示未绑定项目；string 表示所属空间 */
	workspacePath?: string | null;
}

export interface WorkspaceSummary {
	path: string;
	name: string;
}

/** 会话的累计用量;金额缺省说明有请求没配单价,不拿 0 冒充「不要钱」。 */
export interface UsageSummary {
	/** 记录到的请求次数 */
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 各次请求提供方回报的合计累加 */
	total: number;
	cost: number | undefined;
}

/** 会话的活动统计;没记到耗时的请求不进累计,所以各项可能都为零而请求并不为零。 */
export interface ActivitySummary {
	/** 用户发出的提问数 */
	turns: number;
	/** 主对话的请求次数 */
	steps: number;
	llmMs: number;
	toolMs: number;
	ttftMs: number;
	ttftCount: number;
	decodeTokens: number;
	decodeMs: number;
}

/** /api/state 的形状:首屏与重连的单一事实来源。 */
export interface StateInfo {
	running: boolean;
	approval: { id: number; request: ApprovalRequest } | undefined;
	approvalMode: ApprovalMode;
	model: ModelInfo;
	version: string;
	sessionId: string;
	cwd: string;
	effort: ThinkingLevel;
	planMode: boolean;
	contextWindow: number | undefined;
	contextTokens: number | undefined;
	usage: UsageSummary;
	activity: ActivitySummary;
}

export interface SkillInfo {
	name: string;
	description: string;
	path: string;
	scope: "user" | "project";
	/** 只有 Reins 自己技能目录下的用户技能可编辑 */
	editable: boolean;
}

export interface SkillContent {
	name: string;
	description: string;
	content: string;
}

export interface SkillUpdateInput extends SkillInput {
	path: string;
}

export interface PluginInfo {
	name: string;
	kind: string;
	disabled: boolean;
}

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface SettingsModel {
	provider: string;
	providerName: string;
	model: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: readonly ThinkingLevel[];
	contextWindow: number | undefined;
	maxTokens: number | undefined;
	cost: ModelCost | undefined;
}

export type ModelModality = "text" | "image";

/** 提供方编辑用的完整模型声明；高级字段原样保留，表单只改常用项。 */
export interface ProviderModel {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>;
	input: readonly ModelModality[];
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
	maxTokensField: "max_tokens" | "max_completion_tokens";
	headers: Record<string, string>;
}

export interface ProviderView {
	id: string;
	name: string;
	baseUrl?: string;
	api?: string;
	hasApiKey: boolean;
	headers: Record<string, string>;
	promptCacheKey: boolean;
	models: readonly ProviderModel[];
}

export interface ProviderInput {
	id: string;
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	promptCacheKey?: boolean;
	models: readonly ProviderModel[];
}

/** 个性化指令：正文保存在用户级规则文件里，下一回合生效。 */
export interface PersonalizationSnapshot {
	path: string;
	text: string;
	bytes: number;
	maxBytes: number;
}

/** 新建用户级技能的表单。 */
export interface SkillInput {
	name: string;
	description: string;
	content: string;
}

export type McpServerType = "stdio" | "http" | "sse";

/** 新增 MCP server 的表单；stdio 用 command/args/env，http 与 sse 用 url/headers。 */
export interface McpServerInput {
	name: string;
	type: McpServerType;
	command?: string;
	args?: readonly string[];
	url?: string;
	headers?: Readonly<Record<string, string>>;
	env?: Readonly<Record<string, string>>;
}

export interface SettingsSnapshot {
	version: string;
	configPath: string;
	providersPath: string;
	provider: string;
	model: string;
	effort: ThinkingLevel;
	approval: ApprovalMode;
	notify: NotifyMode;
	sandbox: string;
	contextWindow: number | undefined;
	maxTokens: number | undefined;
	compactModel: string | undefined;
	reviewModel: string | undefined;
	models: readonly SettingsModel[];
	mcpServers: readonly {
		name: string;
		type: string;
		disabled: boolean;
		/** connecting / connected / unreachable / disabled / unknown */
		status: string;
		detail: string;
	}[];
	plugins: readonly { name: string; kind: string; disabled: boolean }[];
	skills: readonly {
		name: string;
		description: string;
		path: string;
		scope: "user" | "project";
		editable: boolean;
	}[];
}

export interface FileTreeEntry {
	name: string;
	path: string;
	kind: "file" | "directory";
}

export interface FileTree {
	path: string;
	entries: readonly FileTreeEntry[];
}

export interface FileContent {
	path: string;
	text: string;
	encoding: string;
	hasBom: boolean;
	lossy: boolean;
	binary: boolean;
	truncated: boolean;
	size: number;
}

export interface FileSearchHit {
	path: string;
	kind: "file" | "directory";
}

export interface GitFileChange {
	path: string;
	index: string;
	worktree: string;
	staged: boolean;
	kind: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted" | "unknown";
	from?: string;
}

export interface GitStatus {
	branch: string | undefined;
	upstream: string | undefined;
	ahead: number;
	behind: number;
	files: readonly GitFileChange[];
}

export type WebEvent =
	| { type: "turn_start" }
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "writing_tool_call"; name: string }
	| { type: "tool_start"; callId: string; name: string; args: Record<string, unknown> }
	| { type: "tool_update"; callId: string; text: string }
	| {
			type: "tool_end";
			callId: string;
			name: string;
			isError: boolean;
			durationMs: number;
			summary: string;
			content?: string;
			details?: unknown;
	  }
	| { type: "turn_end"; stopReason: string }
	| {
			type: "usage_recorded";
			kind: string;
			tokens: number;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			llmMs?: number;
			ttftMs?: number;
			contextTokens?: number;
			cost?: number;
	  }
	| { type: "retrying"; attempt: number; maxAttempts: number; reason: string }
	| { type: "compaction_start"; messages: number; tokensBefore: number }
	| { type: "compaction_end"; covered: number; tokensBefore: number; tokensAfter: number }
	| { type: "compaction_failed"; message: string }
	| { type: "compaction_skipped"; message: string }
	| { type: "notice"; message: string }
	| { type: "error"; message: string }
	| { type: "aborted"; cause?: string }
	| { type: "run_end" }
	| { type: "approval_request"; id: number; request: ApprovalRequest }
	| { type: "approval_cleared" }
	| { type: "session_switched" };

export type LlmMessage =
	| { role: "user"; content: string | readonly LlmUserBlock[] }
	| {
			role: "assistant";
			content: readonly (
				| { type: "text"; text: string }
				| { type: "thinking"; text: string }
				| { type: "redactedThinking"; data: string }
				| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
			)[];
	  }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: string; isError: boolean };

export type LlmUserBlock =
	| { type: "text"; text: string }
	| { type: "image"; name?: string };

export type SessionEntry =
	| { type: "message"; message: LlmMessage }
	| { type: string };
