import { STATUS } from "#src/tui/copy.ts";
import { clearAttachments } from "#src/tui/input/attachments.ts";
import { popUndo } from "#src/tui/input/undo.ts";
import { CLEAR_CONFIRM_WINDOW_MS, UNDO_HINT_MS } from "#src/tui/runtime/constants.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";

/**
 * 清空输入框与撤销。
 *
 * Esc 与 Ctrl+C 共用同一条清空路径：清空走 setInput，旧正文与图片照常进撤销栈，
 * Ctrl+Z 撤回。清空本身不区分是哪一个键按的，两个键的撤销行为不会各说各话。
 */

/** 清空输入框；没有可清的内容时返回 false。旧状态由 setInput 压进撤销栈。 */
export function clearDraft(host: TuiHost, state: TuiState): boolean {
	if (state.input.length === 0 && state.pendingImages.length === 0) return false;
	host.setInput("", 0);
	// 清空后在途的读图结果不能再落回来，否则空输入框会突然冒出一张图
	clearAttachments(host);
	state.historyIndex = -1;
	disarmClear(state);
	host.updateCommandMenu();
	host.updateFileMenu();
	host.updateSkillMenu();
	host.setStatus(STATUS.cleared, "notice");
	// 提示停留得比普通状态久一点：撤销入口在这里，一眼没看到就没人知道还能撤
	host.scheduleStatusClear(UNDO_HINT_MS);
	return true;
}

/**
 * Ctrl+Z：退回上一步输入。
 *
 * 撤销不经 setInput：那会把当前状态再压回栈里，撤销与重做来回打转。空栈时返回 false，
 * 交给后面的路径。
 */
export function undoInput(host: TuiHost): boolean {
	const state = host.state;
	const popped = popUndo(state.undoStack);
	if (popped === undefined) return false;
	const snapshot = popped.snapshot;
	state.undoStack = popped.rest;
	state.input = snapshot.text;
	state.inputCursor = Math.min(Math.max(0, snapshot.cursor), snapshot.text.length);
	// 只接回正文里还带着标记的图片：标记被改过时不留下悬空附件
	state.pendingImages = snapshot.images.filter((image) => snapshot.text.includes(image.token));
	state.historyIndex = -1;
	host.updateCommandMenu();
	host.updateFileMenu();
	host.updateSkillMenu();
	host.setStatus(STATUS.restored, "notice");
	host.scheduleStatusClear();
	return true;
}

/** 发出去之后就不该再被撤销拉回来：那已经是上一段输入了。 */
export function resetInputUndo(state: TuiState): void {
	state.undoStack = [];
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
