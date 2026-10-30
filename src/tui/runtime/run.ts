import { describeError } from "../../shared/describe-error.ts";
import type { AgentEventListener } from "../../agent/events.ts";
import { collapseToolGroups, measureTranscriptView } from "../transcript.ts";
import { desktopNotify } from "../terminal.ts";
import { NOTIFY, STATUS } from "../copy.ts";
import type { ImageAttachment } from "../image.ts";
import { markTranscriptDirty } from "./transcript-state.ts";
import { closeThinking, closeText, createEventTarget, freezeSubagentGroups } from "./turn.ts";
import { startSpinner, stopSpinner } from "./status.ts";
import { disarm } from "./lifecycle.ts";
import type { ActiveTurn, LiveTurn, TuiHost } from "./types.ts";

/**
 * 启动一次由事件驱动的运行。
 *
 * 普通提问与 /compact 都走这里：一样的吸顶提示、状态行、转圈与收尾。差别只在交给 run 的
 * 是什么——一次对话，还是一次压缩。
 *
 * 收尾要处理的事都集中在 finally：冻结子代理、折叠工具组、把这一轮期间执行的命令补进
 * 对话流、清审批、报告结果并决定要不要续发队列。分散在各处做会漏掉某条中止路径。
 */
export function startRun(
	host: TuiHost,
	prompt: string,
	images: readonly ImageAttachment[],
	run: (onEvent: AgentEventListener, signal: AbortSignal) => Promise<void>,
): void {
	const { state, options } = host;
	// 同时只允许一轮：两个驱动并行会交叉写同一个会话，而且旧 run 的收尾会因为
	// activeTurn 已被覆盖而整段跳过（清审批、折叠工具组、队列续发都不会发生）。
	if (state.activeTurn !== undefined) return;
	const shown = prompt.trim();
	const turn: LiveTurn = {
		prompt: shown.length > 0 ? shown : images.length > 0 ? "[image]" : "",
		response: [],
	};
	state.turns.push(turn);
	markTranscriptDirty(state);
	const active: ActiveTurn = {
		turn,
		controller: new AbortController(),
		startedAt: Date.now(),
		lines: [],
		textBlock: undefined,
		thinkingStartedAt: undefined,
		thinkingSecond: 0,
		toolSecond: 0,
		thinkingBlock: undefined,
		tokensUsed: 0,
		outcome: "done",
	};
	state.activeTurn = active;
	state.hasInput = true;
	state.follow = true;
	disarm(state);
	host.resetStatusMeta();
	if (state.statusClearTimer !== undefined) {
		clearTimeout(state.statusClearTimer);
		state.statusClearTimer = undefined;
	}
	host.setStatus(STATUS.waitingForModel);

	const width = host.terminalWidth();
	const mainHeight = host.mainAreaHeight();
	state.scrollTop = measureTranscriptView(host.currentTranscript(width), mainHeight).lastPromptStart;
	startSpinner(state, host.render, () => host.syncApprovalPrompt());
	host.render();

	void run(createEventTarget(host), active.controller.signal)
		.catch((error) => {
			if (state.finished || state.activeTurn !== active) return;
			closeThinking(host, active);
			host.appendLine(active, {
				text: `Error: ${describeError(error)}`,
				kind: "error",
			});
			active.outcome = "error";
			host.setStatus(STATUS.error, "error");
		})
		.finally(() => {
			if (state.activeTurn !== active) return;
			closeThinking(host, active);
			closeText(active);
			// 回合结束:还留在面板的任务表退回静态,转圈与扫光只在运行期间存在
			if (state.currentTodo?.running === true) state.currentTodo.running = false;
			freezeSubagentGroups(active);
			// 命令塌缩会把多条独立行并成一条组行，行数组可能整体变短，只能全量同步
			collapseToolGroups(active.lines);
			host.syncTurnFull(active);
			state.activeTurn = undefined;
			stopSpinner(state);
			// 这一轮期间切过的模型/思考等级，现在落到对话流末尾
			if (state.pendingCommandTurns.length > 0) {
				state.turns.push(...state.pendingCommandTurns);
				state.pendingCommandTurns.length = 0;
				markTranscriptDirty(state);
			}
			options.approval?.denyAll();
			host.syncApprovalPrompt();
			if (state.finished) return;
			disarm(state);
			const completedPlan = active.outcome === "done" ? state.pendingPlan : undefined;
			state.pendingPlan = undefined;
			options.agent?.refreshInfo();
			if (active.outcome === "aborted") {
				// 主动停下由对话流里的 Interrupted 说明，状态行不再留结局
				host.clearStatus();
			} else if (active.outcome === "done") {
				host.clearStatus();
			} else {
				host.setStatus(STATUS.error, "error");
				// 回合已经结束：把耗时与用量定格，错误提示保留时显示这一轮的最终值
				state.statusElapsedMs = Math.max(0, Date.now() - active.startedAt);
				state.statusTokens = active.tokensUsed;
				host.scheduleStatusClear();
			}
			if (completedPlan !== undefined) {
				if (state.input.length === 0) {
					host.openPlanReview(completedPlan);
				} else {
					// 输入框里还有草稿：整屏页会把使用者正在写的内容连同下一次按键一起抢走。
					// 计划卡已经留在对话流里，双击即可打开审批页。
					host.setStatus(STATUS.planReady, "notice");
					host.scheduleStatusClear();
				}
			}
			host.render();
			if (active.outcome !== "aborted") {
				notify(host, active.outcome === "done" ? NOTIFY.done : NOTIFY.failed);
			}
			// 排队消息接上：中止是使用者的明确意图，默认不替他续发；只有 Esc 请求过立即发送才例外。
			// 计划审批页打开时先暂停队列，否则排队消息会越过审批直接进入下一轮。
			const sendQueued = state.sendQueuedAfterAbort;
			state.sendQueuedAfterAbort = false;
			if (
				completedPlan === undefined &&
				(active.outcome !== "aborted" || sendQueued) &&
				state.queued.length > 0
			) {
				drainQueue(host);
			}
		});
}

/** 一轮结束后取队首再发一轮。 */
export function drainQueue(host: TuiHost): void {
	const next = host.state.queued.shift();
	if (next === undefined) return;
	host.launch(next.text, next.images);
}

/** 一轮结束的提醒。auto 只在终端失焦时响铃；desktop 在 macOS/Linux 调系统通知。 */
export function notify(host: TuiHost, message: string): void {
	const configured = host.options.notify ?? "auto";
	const mode = typeof configured === "function" ? configured() : configured;
	if (mode === "off") return;
	if (mode === "auto" && host.state.windowFocused) return;
	if (mode === "desktop" && process.platform !== "win32") {
		desktopNotify(message);
		return;
	}
	host.state.stdout.write("\x07");
}

