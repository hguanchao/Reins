import { stripVTControlCharacters } from "node:util";

import { markTranscriptDirty } from "#src/tui/runtime/transcript-state.ts";
import { isRunningTool } from "#src/tui/transcript/model.ts";
import type { TranscriptLine } from "#src/tui/transcript/types.ts";
import { STATUS_CLEAR_MS, STATUS_ERROR_CLEAR_MS, SWEEP_STEP } from "#src/tui/runtime/constants.ts";
import type { TuiState, ActiveTurn } from "#src/tui/runtime/types.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "#src/tui/runtime/constants.ts";

/**
 * 状态行与转圈。
 *
 * 状态行只有一行，写入路径全部收在这里，方便统一清空计时与用量。
 */

export function setStatus(
	state: TuiState,
	text: string,
	tone?: "warning" | "error" | "notice",
): void {
	// 新状态作废之前登记的自动清除：那个计时器属于上一条提示，让它继续跑会在 1.5 秒后
	// 把正在显示的运行状态清掉（回合中途附加图片后紧接着跑工具就会这样）。
	if (state.statusClearTimer !== undefined) {
		clearTimeout(state.statusClearTimer);
		state.statusClearTimer = undefined;
	}
	state.statusText = stripVTControlCharacters(text).replace(/[\r\n\t]+/g, " ").trim();
	state.statusTone = tone;
	// 新状态属于新的阶段，上一条留下的定格值不再适用；运行中的耗时与用量由渲染现算
	state.statusElapsedMs = 0;
	state.statusTokens = 0;
	state.statusPhaseStartedAt = Date.now();
}

/** 立即清空运行状态。完成后不保留额外的提示，回复本身就是结束信号。 */
export function clearStatus(state: TuiState): void {
	state.statusText = undefined;
	state.statusTone = undefined;
	resetStatusMeta(state);
}

/** 清零状态行的计时与用量:回合开始、命令切换、状态清空的场合都要回到同一起点。 */
export function resetStatusMeta(state: TuiState): void {
	state.statusElapsedMs = 0;
	state.statusTokens = 0;
	if (state.copyNoticeTimer !== undefined) {
		clearTimeout(state.copyNoticeTimer);
		state.copyNoticeTimer = undefined;
	}
	state.copyNotice = undefined;
}

export function scheduleStatusClear(
	state: TuiState,
	render: () => void,
	delayMs = STATUS_CLEAR_MS,
): void {
	// 错误与警告留给使用者读完：按更长的窗口自动消失，而不是永久占位。原来的设计是
	// 「留给下一条状态或回合收尾覆盖」，但空闲时发生的错误（命令失败、剪贴板失败、MCP
	// 失败）之后没有任何覆盖点，等于永不消失。
	const delay =
		state.statusTone === "warning" || state.statusTone === "error"
			? STATUS_ERROR_CLEAR_MS
			: delayMs;
	if (state.statusClearTimer !== undefined) clearTimeout(state.statusClearTimer);
	state.statusClearTimer = setTimeout(() => {
		state.statusClearTimer = undefined;
		clearStatus(state);
		render();
	}, delay);
}

export function stopSpinner(state: TuiState): void {
	if (state.spinnerTimer === undefined) return;
	clearInterval(state.spinnerTimer);
	state.spinnerTimer = undefined;
}

/**
 * 启动刷新帧。
 *
 * 帧推进转圈与扫光，并让运行中的思考标题和子代理组头按整秒失效；耗时本身不在这里
 * 累加，由渲染按各自的时间戳现算。
 */
export function startSpinner(
	state: TuiState,
	render: () => void,
	syncApprovalPrompt: () => void,
): void {
	if (state.spinnerTimer !== undefined) return;

	state.spinnerTimer = setInterval(() => {
		state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
		state.sweepPhase = (state.sweepPhase + SWEEP_STEP) % 1;
		const active = state.activeTurn;
		if (active !== undefined) {
			tickActiveStatus(state, active, syncApprovalPrompt);
		}
		render();
	}, SPINNER_INTERVAL_MS);
}

/** 刷新帧里属于「当前这一轮」的部分：思考标题、任务卡与运行中的工具、子代理。 */
function tickActiveStatus(
	state: TuiState,
	active: ActiveTurn,
	syncApprovalPrompt: () => void,
): void {
	syncApprovalPrompt();

	// 所有实时耗时统一按 0.1s 连续跳动：转圈本来就是 100ms 一帧，凡是有内容在跑就把
	// 对话流一起标脏，渲染端每帧重算耗时。前缀缓存把重建限制在最后一个回合，长会话
	// 也扛得住；常驻任务面板每帧重画，不依赖这里的标脏。
	if (active.thinkingBlock !== undefined && active.thinkingStartedAt !== undefined) {
		markTranscriptDirty(state);
	}
	// 运行中的子代理组头:计数与耗时都在变,有组在跑才标脏重建
	let subagentsRunning = false;
	for (const line of active.lines) {
		if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
		if (line.members.some((member) => member.status === "running")) {
			subagentsRunning = true;
			line.durationMs = undefined;
		}
	}
	if (subagentsRunning) markTranscriptDirty(state);

	if (hasRunningTool(active.lines)) markTranscriptDirty(state);
	// 对话流里的任务卡头行带当前任务的实时耗时；卡 running 期间同样逐帧重算
	if (state.currentTodo?.running === true) markTranscriptDirty(state);
}

/** 这一轮里是否还有工具没结束；组内的成员也要看，展开的组会显示它们。 */
function hasRunningTool(lines: readonly TranscriptLine[]): boolean {
	for (const line of lines) {
		if (typeof line !== "object" || line === null) continue;
		if (line.kind === "tool" && isRunningTool(line)) return true;
		if (line.kind === "toolGroup" && line.members.some(isRunningTool)) return true;
	}
	return false;
}
