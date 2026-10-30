import { DOUBLE_CLICK_MS, WHEEL_STEP } from "#src/tui/runtime/constants.ts";
import { invalidateTranscriptPrefix, markTranscriptDirty } from "#src/tui/runtime/transcript-state.ts";
import { scrollTopForRow, toggleLastExpandable, toggleLastToolResult } from "#src/tui/transcript.ts";
import type { MouseInput } from "#src/tui/input/keys.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";

/**
 * 对话流指针与滚动键处理。
 *
 * 审批卡和普通输入两条分发路径都要先处理「滚轮、拖动滚动条、双击展开」，规则必须完全
 * 一致：这两处各写一份时，很容易只在一侧修好边界。这里只负责状态变化，是否重绘由
 * 调用方决定。
 */

/** 记录这次按下，并判断它与上一次是否构成同一位置的双击。 */
export function trackClick(state: TuiState, event: MouseInput): boolean {
	const now = Date.now();
	const doubleClick =
		state.lastClick !== undefined &&
		now - state.lastClick.at <= DOUBLE_CLICK_MS &&
		state.lastClick.row === event.row &&
		state.lastClick.column === event.column;
	state.lastClick = { at: now, row: event.row, column: event.column };
	return doubleClick;
}

/** 按累计滚轮格数滚动；返回位置是否变化。 */
export function applyWheelScroll(host: TuiHost, state: TuiState, steps: number): boolean {
	if (steps === 0) return false;
	const limit = host.maxScroll();
	const before = state.scrollTop;
	state.scrollTop = Math.min(limit, Math.max(0, state.scrollTop + steps * WHEEL_STEP));
	state.follow = state.scrollTop >= limit;
	return state.scrollTop !== before;
}

/** 按拖动到的行滚动；返回位置是否变化。 */
export function applyDragScroll(
	host: TuiHost,
	state: TuiState,
	row: number,
	mainHeight: number,
): boolean {
	const limit = host.maxScroll();
	const before = state.scrollTop;
	state.scrollTop = scrollTopForRow(row, mainHeight, limit);
	state.follow = state.scrollTop >= limit;
	return state.scrollTop !== before;
}

/**
 * PageUp / PageDown / Ctrl+Home。
 *
 * 返回是否消费了这次按键；不是滚动键时为 false，调用方继续往下分发。
 */
export function handleScrollKey(
	host: TuiHost,
	state: TuiState,
	text: string,
	mainHeight: number,
): boolean {
	if (text === "\x1b[5~") {
		state.scrollTop = Math.max(0, state.scrollTop - mainHeight);
		// 已经到顶时不要取消跟随：内容本来就没超出屏幕，之后的新输出仍应自动可见
		state.follow = state.scrollTop >= host.maxScroll();
		return true;
	}
	if (text === "\x1b[6~") {
		const limit = host.maxScroll();
		state.scrollTop = Math.min(limit, state.scrollTop + mainHeight);
		state.follow = state.scrollTop >= limit;
		return true;
	}
	if (text === "\x1b[1;5H") {
		state.scrollTop = 0;
		state.follow = host.maxScroll() <= 0;
		return true;
	}
	// Ctrl+End：跳到最新。帮助页承诺了它，终端发出的序列是 CSI 1;5F
	if (text === "\x1b[1;5F") {
		const limit = host.maxScroll();
		state.scrollTop = limit;
		state.follow = true;
		return true;
	}
	return false;
}

/**
 * Ctrl+E 展开/收起最后一块思考或工具组，Ctrl+O 切换最后一条工具结果。
 *
 * 返回是否消费了这次按键；没有可展开目标时也消费，避免按键漏进输入框成为正文。
 */
export function handleToggleKey(state: TuiState, text: string): boolean {
	if (text === "\x05") {
		if (toggleLastExpandable(state.turns)) {
			invalidateTranscriptPrefix(state);
			markTranscriptDirty(state);
			state.follow = false;
		}
		return true;
	}
	if (text === "\x0f") {
		const tool = toggleLastToolResult(state.turns);
		if (tool !== undefined) {
			// 刚展开的这条就是 Ctrl+G 要继续看的那条，别再跳回“最新”
			state.viewerTool = tool;
			invalidateTranscriptPrefix(state);
			markTranscriptDirty(state);
			state.follow = false;
		}
		return true;
	}
	return false;
}
