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

export interface ModelInfo {
	provider: string;
	model: string;
	name: string;
}

export interface SessionSummary {
	id: string;
	title: string | undefined;
	updatedAt: string;
}

/** /api/state 的形状:首屏与重连的单一事实来源。 */
export interface StateInfo {
	running: boolean;
	approval: { id: number; request: ApprovalRequest } | undefined;
	approvalMode: ApprovalMode;
	model: ModelInfo;
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
	  }
	| { type: "turn_end"; stopReason: string }
	| { type: "usage_recorded"; kind: string; tokens: number }
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
				| { type: "toolCall"; id: string; name: string }
			)[];
	  }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: string; isError: boolean };

export type LlmUserBlock =
	| { type: "text"; text: string }
	| { type: "image"; name?: string };

export type SessionEntry =
	| { type: "message"; message: LlmMessage }
	| { type: string };
