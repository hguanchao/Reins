import { formatDuration } from "../../format.ts";
import { markTranscriptDirty } from "./transcript-state.ts";
import { STATUS_CLEAR_MS, SWEEP_STEP } from "./constants.ts";
import type { TuiState, ActiveTurn } from "./types.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./constants.ts";

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
	state.statusText = text;
	state.statusTone = tone;
	state.statusPhaseMs = 0;
	state.statusPhaseStartedAt = Date.now();
}

/** 立即清空运行状态。完成后不保留额外的提示，回复本身就是结束信号。 */
export function clearStatus(state: TuiState): void {
	state.statusText = undefined;
	state.statusTone = undefined;
	state.statusPhaseMs = 0;
	resetStatusMeta(state);
}

/** 清零状态行的计时与用量:回合开始、命令切换、状态清空的场合都要回到同一起点。 */
export function resetStatusMeta(state: TuiState): void {
	state.statusElapsedMs = 0;
	state.statusTokens = 0;
}

export function scheduleStatusClear(state: TuiState, render: () => void): void {
	if (state.statusClearTimer !== undefined) clearTimeout(state.statusClearTimer);
	state.statusClearTimer = setTimeout(() => {
		state.statusClearTimer = undefined;
		clearStatus(state);
		render();
	}, STATUS_CLEAR_MS);
}

export function stopSpinner(state: TuiState): void {
	if (state.spinnerTimer === undefined) return;
	clearInterval(state.spinnerTimer);
	state.spinnerTimer = undefined;
}

/**
 * 启动刷新帧。
 *
 * 帧同时推进转圈、扫光、耗时与思考标题；有子代理在跑时还要标脏对话流，
 * 让组头的计数与耗时跟着走。
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

/** 刷新帧里属于「当前这一轮」的部分：耗时、用量、思考标题与运行中的子代理组。 */
function tickActiveStatus(
	state: TuiState,
	active: ActiveTurn,
	syncApprovalPrompt: () => void,
): void {
	const now = Date.now();
	state.statusElapsedMs = now - active.startedAt;
	state.statusPhaseMs = Math.max(0, now - state.statusPhaseStartedAt);
	state.statusTokens = active.tokensUsed;
	syncApprovalPrompt();

	const block = active.thinkingBlock;
	const startedAt = active.thinkingStartedAt;
	if (block !== undefined && startedAt !== undefined) {
		// 按整秒更新，避免每个 spinner tick 都重建整份对话流
		const header = `Thinking… ${formatDuration(Math.floor((now - startedAt) / 1000) * 1000)}`;
		if (block.header !== header) {
			block.header = header;
			markTranscriptDirty(state);
		}
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
}
