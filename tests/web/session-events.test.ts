import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Dispatch, SetStateAction } from "react";

import { dispatchEvent, type EventDeps } from "#web/state/session-events.ts";
import type { ActivitySummary, ApprovalRequest, UsageSummary, WebEvent } from "#web/protocol.ts";
import type { GlobalPanelId } from "#web/panels/types.ts";
import type { Line } from "#web/transcript/lines.ts";

function setter<T>(initial: T) {
	let value = initial;
	let calls = 0;
	const dispatch: Dispatch<SetStateAction<T>> = (update) => {
		calls += 1;
		value = typeof update === "function" ? (update as (current: T) => T)(value) : update;
	};
	return {
		dispatch,
		get value(): T {
			return value;
		},
		get calls(): number {
			return calls;
		},
	};
}

function harness() {
	const lines = setter<readonly Line[]>([]);
	const running = setter(false);
	const awaiting = setter(false);
	const approval = setter<{ readonly id: number; readonly request: ApprovalRequest } | undefined>(undefined);
	const activity = setter<ActivitySummary>({
		turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftCount: 0, decodeTokens: 0, decodeMs: 0,
	});
	const usage = setter<UsageSummary>({
		requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: undefined,
	});
	const contextTokens = setter<number | undefined>(undefined);
	const queue = setter<readonly { readonly id: string; readonly text: string }[]>([]);
	const activePanel = setter<GlobalPanelId | undefined>(undefined);
	const sideFullscreen = setter(false);
	const notices: string[] = [];
	const refresh = { sessions: 0, settings: 0, git: 0, reload: 0 };

	const deps: EventDeps = {
		outcome: { current: "done" },
		errorNotified: { current: false },
		approvalNotified: { current: undefined },
		setLines: lines.dispatch,
		setRunning: running.dispatch,
		setAwaitingModel: awaiting.dispatch,
		setApproval: approval.dispatch,
		setActivity: activity.dispatch,
		setUsage: usage.dispatch,
		setContextTokens: contextTokens.dispatch,
		setQueue: queue.dispatch,
		setActivePanel: activePanel.dispatch,
		setSideFullscreen: sideFullscreen.dispatch,
		maybeNotify: (title) => notices.push(title),
		reload: () => { refresh.reload += 1; },
		refreshSessions: () => { refresh.sessions += 1; },
		refreshSettings: () => { refresh.settings += 1; },
		refreshGit: () => { refresh.git += 1; },
	};
	return { deps, lines, running, awaiting, approval, activity, usage, contextTokens, queue, activePanel, notices, refresh };
}

const request: ApprovalRequest = { tool: "bash", risk: "normal", detail: "rm -rf tmp" };

function event<T extends WebEvent>(value: T): WebEvent {
	return value;
}

describe("服务端事件分发", () => {
	it("回合开始重置结果标记并进入运行态", () => {
		const h = harness();
		h.deps.outcome.current = "error";
		h.deps.errorNotified.current = true;
		dispatchEvent(event({ type: "turn_start" }), h.deps);
		assert.equal(h.deps.outcome.current, "running");
		assert.equal(h.deps.errorNotified.current, false);
		assert.equal(h.running.value, true);
		assert.equal(h.awaiting.value, true);
	});

	it("文本增量追加到会话流，工具增量只改对应工具行", () => {
		const h = harness();
		dispatchEvent(event({ type: "text_delta", text: "正在处理" }), h.deps);
		assert.equal(h.lines.value.length, 1);
		assert.equal(h.awaiting.value, false);
		dispatchEvent(event({ type: "tool_start", callId: "c1", name: "read", args: {} }), h.deps);
		dispatchEvent(event({ type: "tool_update", callId: "c1", text: "输出" }), h.deps);
		const tool = h.lines.value[1];
		assert.equal(tool?.kind, "tool");
		assert.equal(tool?.kind === "tool" ? tool.detail : "", "输出");
	});

	it("回合结束收尾并刷新会话与 Git", () => {
		const h = harness();
		dispatchEvent(event({ type: "run_end" }), h.deps);
		assert.equal(h.running.value, false);
		assert.equal(h.awaiting.value, false);
		assert.equal(h.deps.outcome.current, "done");
		assert.equal(h.refresh.sessions, 1);
		assert.equal(h.refresh.git, 1);
		assert.deepEqual(h.notices, ["Reins 任务完成"]);
	});

	it("错误只提醒一次，之后的完成通知不再重复", () => {
		const h = harness();
		dispatchEvent(event({ type: "error", message: "连接断开" }), h.deps);
		dispatchEvent(event({ type: "error", message: "再次断开" }), h.deps);
		dispatchEvent(event({ type: "run_end" }), h.deps);
		assert.deepEqual(h.notices, ["Reins 任务失败"]);
		assert.equal(h.lines.value.filter((line) => line.kind === "notice").length, 2);
	});

	it("审批请求按 id 去重通知，清除时一并退出延迟态", () => {
		const h = harness();
		dispatchEvent(event({ type: "approval_request", id: 7, request }), h.deps);
		dispatchEvent(event({ type: "approval_request", id: 7, request }), h.deps);
		assert.equal(h.approval.value?.id, 7);
		assert.deepEqual(h.notices, ["Reins 需要审批"]);
		dispatchEvent(event({ type: "approval_cleared" }), h.deps);
		assert.equal(h.approval.value, undefined);
		assert.equal(h.awaiting.value, false);
	});

	it("切换会话清空流与队列，并整份重载", () => {
		const h = harness();
		dispatchEvent(event({ type: "text_delta", text: "旧会话" }), h.deps);
		dispatchEvent(event({ type: "approval_request", id: 3, request }), h.deps);
		dispatchEvent(event({ type: "session_switched" }), h.deps);
		assert.equal(h.lines.value.length, 0);
		assert.equal(h.queue.value.length, 0);
		assert.equal(h.approval.value, undefined);
		assert.equal(h.contextTokens.value, undefined);
		assert.equal(h.refresh.reload, 1);
		assert.equal(h.refresh.settings, 1);
	});
});
