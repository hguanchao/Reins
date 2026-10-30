import { STATUS } from "#src/tui/copy.ts";
import { clearAttachments } from "#src/tui/input/attachments.ts";
import { CLEAR_CONFIRM_WINDOW_MS, UNDO_HINT_MS } from "#src/tui/runtime/constants.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";

/**
 * 清空输入框与撤销。
 *
 * Esc 与 Ctrl+C 共用同一条清空路径：草稿先放进撤销槽，再清输入框；Ctrl+Z 原样放回。
 * 清空本身不区分是哪一个键按的，这样两个键的撤销行为不会各说各话。
 */

/** 清空输入框，把草稿留在撤销槽里；没有可清的内容时返回 false。 */
export function clearDraft(host: TuiHost, state: TuiState): boolean {
	if (state.input.length === 0 && state.pendingImages.length === 0) return false;
	state.clearedDraft = {
		text: state.input,
		cursor: state.inputCursor,
		images: [...state.pendingImages],
	};
	host.setInput("", 0);
	// 清空后在途的读图结果不能再落回来，否则空输入框会突然冒出一张图
	clearAttachments(host);
	state.historyIndex = -1;
	disarmClear(state);
	host.updateCommandMenu();
	host.updateFileMenu();
	host.setStatus(STATUS.cleared, "notice");
	// 提示停留得比普通状态久一点：撤销入口在这里，一眼没看到就没人知道还能撤
	host.scheduleStatusClear(UNDO_HINT_MS);
	return true;
}

/**
 * Ctrl+Z：把刚清空的草稿放回来。
 *
 * 输入框里已经有新内容时不动：清空之后打的字比被清掉的草稿更近，直接盖上去等于第二次
 * 误伤。没有可撤销的草稿时返回 false，交给后面的路径。
 */
export function restoreDraft(host: TuiHost, state: TuiState): boolean {
	const draft = state.clearedDraft;
	if (draft === undefined) return false;
	if (state.input.length > 0 || state.pendingImages.length > 0) return false;
	state.clearedDraft = undefined;
	host.setInput(draft.text, draft.cursor);
	// 只接回正文里还带着标记的图片：草稿里的标记被改过时不留下悬空附件
	state.pendingImages = draft.images.filter((image) => draft.text.includes(image.token));
	state.historyIndex = -1;
	host.updateCommandMenu();
	host.updateFileMenu();
	host.setStatus(STATUS.restored, "notice");
	host.scheduleStatusClear();
	return true;
}

/** 发出去之后草稿就不该再被撤销拉回来：那已经是上一段输入了。 */
export function forgetDraft(state: TuiState): void {
	state.clearedDraft = undefined;
}

/** 第一次 Esc：开始计时，窗口内再按一次才清空。 */
export function armClear(state: TuiState, onExpire: () => void): void {
	disarmClear(state);
	state.escClearArmed = true;
	state.escClearTimer = setTimeout(onExpire, CLEAR_CONFIRM_WINDOW_MS);
}

export function disarmClear(state: TuiState): void {
	if (state.escClearTimer !== undefined) {
		clearTimeout(state.escClearTimer);
		state.escClearTimer = undefined;
	}
	state.escClearArmed = false;
}
