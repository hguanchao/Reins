import type { Dispatch, SetStateAction } from "react";

import type { QueuedMessage } from "../chat/composer/model.ts";
import type { ActivitySummary, UsageSummary, WebEvent } from "../protocol.ts";
import type { GlobalPanelId } from "../panels/types.ts";
import type { Line } from "../transcript/lines.ts";
import { appendToLast, sealStreaming, updateTool } from "../transcript/lines.ts";
import type { PendingGate } from "./approval-shortcut.ts";
import { applyActivityRecorded, applyToolDuration, applyUsageRecorded } from "./usage.ts";

/**
 * 服务端事件分发。
 *
 * 只通过 deps 里的 setter 与回调产生作用，不直接碰 React 状态；这样每种事件该改什么
 * 可以独立验证，界面组件只负责把真实 setter 接进来。
 */

export interface EventDeps {
	readonly outcome: { current: "running" | "done" | "error" | "aborted" };
	readonly errorNotified: { current: boolean };
	readonly approvalNotified: { current: number | undefined };
	readonly setLines: Dispatch<SetStateAction<readonly Line[]>>;
	readonly setRunning: Dispatch<SetStateAction<boolean>>;
	readonly setAwaitingModel: Dispatch<SetStateAction<boolean>>;
	readonly setDeferred: Dispatch<SetStateAction<boolean>>;
	readonly setApproval: Dispatch<SetStateAction<PendingGate | undefined>>;
	readonly setActivity: Dispatch<SetStateAction<ActivitySummary>>;
	readonly setUsage: Dispatch<SetStateAction<UsageSummary>>;
	readonly setContextTokens: Dispatch<SetStateAction<number | undefined>>;
	readonly setQueue: Dispatch<SetStateAction<readonly QueuedMessage[]>>;
	readonly setActivePanel: Dispatch<SetStateAction<GlobalPanelId | undefined>>;
	readonly setSideFullscreen: Dispatch<SetStateAction<boolean>>;
	maybeNotify(title: string, body: string): void;
	reload(): void;
	refreshSessions(): void;
	refreshSettings(): void;
	refreshGit(): void;
}

export function dispatchEvent(event: WebEvent, deps: EventDeps): void {
	switch (event.type) {
		case "turn_start":
			deps.outcome.current = "running";
			deps.errorNotified.current = false;
			deps.approvalNotified.current = undefined;
			deps.setLines(sealStreaming);
			deps.setRunning(true);
			deps.setAwaitingModel(true);
			return;
		case "writing_tool_call":
			deps.setAwaitingModel(false);
			return;
		case "text_delta":
			deps.setAwaitingModel(false);
			deps.setLines((current) => appendToLast(current, "assistant", event.text));
			return;
		case "reasoning_delta":
			deps.setAwaitingModel(false);
			deps.setLines((current) => appendToLast(current, "thinking", event.text));
			return;
		case "tool_start":
			deps.setAwaitingModel(false);
			deps.setLines((current) => [
				...current,
				{
					kind: "tool",
					callId: event.callId,
					name: event.name,
					args: event.args,
					running: true,
					isError: false,
					durationMs: undefined,
					summary: undefined,
					detail: "",
					content: undefined,
					details: undefined,
				},
			]);
			return;
		case "tool_update":
			deps.setLines((current) =>
				updateTool(current, event.callId, (line) => ({ ...line, detail: line.detail + event.text })),
			);
			return;
		case "tool_end":
			deps.setLines((current) =>
				updateTool(current, event.callId, (line) => ({
					...line,
					running: false,
					isError: event.isError,
					durationMs: event.durationMs,
					summary: event.summary,
					content: event.content,
					details: event.details,
				})),
			);
			deps.setActivity((current) => applyToolDuration(current, event.durationMs));
			return;
		case "turn_end":
			deps.setLines(sealStreaming);
			return;
		case "usage_recorded":
			if (event.contextTokens !== undefined) deps.setContextTokens(event.contextTokens);
			deps.setUsage((current) => applyUsageRecorded(current, event));
			deps.setActivity((current) => applyActivityRecorded(current, event));
			return;
		case "retrying":
			deps.setLines((current) => [
				...current,
				{ kind: "notice", text: `重试中 (${event.attempt}/${event.maxAttempts})：${event.reason}`, tone: "info" },
			]);
			return;
		case "compaction_start":
			deps.setLines((current) => [
				...current,
				{ kind: "notice", text: `压缩上下文：替换前 ${event.messages} 条消息`, tone: "info" },
			]);
			return;
		case "compaction_end":
			deps.setLines((current) => [
				...current,
				{ kind: "notice", text: `压缩完成：~${event.tokensBefore} → ${event.tokensAfter} tokens`, tone: "info" },
			]);
			deps.setContextTokens(event.tokensAfter);
			return;
		case "compaction_failed":
		case "compaction_skipped":
			deps.setLines((current) => [...current, { kind: "notice", text: event.message, tone: "info" }]);
			return;
		case "notice":
			deps.setLines((current) => [...current, { kind: "notice", text: event.message, tone: "info" }]);
			return;
		case "aborted":
			deps.outcome.current = "aborted";
			deps.setLines((current) => [...current, { kind: "notice", text: "已停止", tone: "info" }]);
			return;
		case "error":
			// error 后面通常还会跟一个 run_end；这里记下已提醒，避免再报一次「完成」
			if (!deps.errorNotified.current) {
				deps.errorNotified.current = true;
				deps.outcome.current = "error";
				deps.maybeNotify("Reins 任务失败", "请回到窗口查看详情");
			}
			deps.setLines((current) => [...current, { kind: "notice", text: event.message, tone: "error" }]);
			return;
		case "run_end":
			if (deps.outcome.current !== "aborted" && !deps.errorNotified.current) {
				deps.maybeNotify("Reins 任务完成", "任务已结束");
			}
			deps.outcome.current = "done";
			deps.setRunning(false);
			deps.setAwaitingModel(false);
			deps.setDeferred(false);
			deps.setLines(sealStreaming);
			deps.refreshSessions();
			deps.refreshGit();
			return;
		case "approval_request":
			if (deps.approvalNotified.current !== event.id) {
				deps.approvalNotified.current = event.id;
				deps.maybeNotify("Reins 需要审批", "有新的操作等待确认");
			}
			deps.setAwaitingModel(false);
			deps.setDeferred(false);
			deps.setApproval({ id: event.id, request: event.request });
			return;
		case "approval_cleared":
			deps.setApproval(undefined);
			deps.setDeferred(false);
			return;
		case "session_switched":
			deps.outcome.current = "done";
			deps.errorNotified.current = false;
			deps.approvalNotified.current = undefined;
			deps.setLines([]);
			deps.setContextTokens(undefined);
			deps.setActivePanel(undefined);
			deps.setSideFullscreen(false);
			deps.setQueue([]);
			deps.setApproval(undefined);
			deps.reload();
			deps.refreshSessions();
			deps.refreshGit();
			deps.refreshSettings();
			return;
		default:
			return;
	}
}
