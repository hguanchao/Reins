import type { TuiState } from "./types.ts";

/**
 * 输入历史。
 *
 * 只在本次界面会话里保留，不落盘；与命令补全一样，历史移动后要重算补全与画面。
 */

export function rememberInput(state: TuiState, value: string): void {
	const text = value.trim();
	if (text.length === 0) return;
	if (state.inputHistory.at(-1) !== text) state.inputHistory.push(text);
	if (state.inputHistory.length > 100) state.inputHistory.shift();
	state.historyIndex = -1;
}

/**
 * 上下键翻历史；到达最新一端时回到草稿。
 *
 * 返回 true 表示这次按键已被历史消费。
 */
export function recallHistory(
	state: TuiState,
	delta: -1 | 1,
	after: () => void,
): boolean {
	if (state.inputHistory.length === 0) return false;
	if (delta < 0) {
		if (state.historyIndex === -1) {
			state.historyDraft = state.input;
			state.historyIndex = state.inputHistory.length;
		}
		if (state.historyIndex > 0) state.historyIndex -= 1;
	} else {
		if (state.historyIndex === -1) return false;
		state.historyIndex += 1;
		if (state.historyIndex >= state.inputHistory.length) {
			state.historyIndex = -1;
			state.input = state.historyDraft;
			state.inputCursor = state.input.length;
			after();
			return true;
		}
	}
	const recalled = state.inputHistory[state.historyIndex] ?? "";
	state.input = recalled;
	state.inputCursor = recalled.length;
	after();
	return true;
}
