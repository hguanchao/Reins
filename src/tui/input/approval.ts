import { MOUSE_BUTTON_MASK, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, approvalKey, dragMotion, scrollKey } from "./keys.ts";
import type { MouseInput } from "./keys.ts";
import { approvalActionAt } from "../panel/approval-panel.ts";
import { scrollTopForRow, toggleLastExpandable, toggleLastToolResult } from "../transcript.ts";
import { DOUBLE_CLICK_MS, WHEEL_STEP } from "../runtime/constants.ts";
import { markTranscriptDirty } from "../runtime/transcript-state.ts";
import type { InputDeps } from "./dispatch.ts";
import type { TuiHost } from "../runtime/types.ts";

export function handleApprovalInput(
	host: TuiHost,
	deps: InputDeps,
	text: string,
	mouseOf: () => readonly MouseInput[],
): void {
	const state = host.state;
	const prompt = state.approvalPrompt;
	if (prompt === undefined) return;
	const panelWidth = host.terminalWidth();
	const mainHeight = host.mainAreaHeight();
	const panelTop = host.approvalPanelTop();
	let wheelSteps = 0;
	let dragRow: number | undefined;

	for (const event of mouseOf()) {
		const motion = dragMotion(event.button);
		const action =
			event.row === panelTop + 5 ? approvalActionAt(panelWidth, prompt, event.column - 1) : undefined;
		if (event.press && event.button === MOUSE_WHEEL_UP) {
			wheelSteps -= 1;
			continue;
		}
		if (event.press && event.button === MOUSE_WHEEL_DOWN) {
			wheelSteps += 1;
			continue;
		}
		if (motion) {
			if (action !== undefined && action !== state.approvalSelection) {
				state.approvalSelection = action;
				deps.render();
			}
			if (state.draggingScrollbar) dragRow = event.row;
			continue;
		}
		if (!event.press) {
			state.draggingScrollbar = false;
			continue;
		}
		if ((event.button & MOUSE_BUTTON_MASK) !== 0) continue;
		if (action !== undefined) {
			host.resolveApproval(action);
			return;
		}
		if (event.column === panelWidth && event.row <= mainHeight && state.turns.length > 0) {
			state.draggingScrollbar = true;
			dragRow = event.row;
			continue;
		}
		state.draggingScrollbar = false;
		if (event.row > mainHeight) continue;

		const now = Date.now();
		const doubleClick =
			state.lastClick !== undefined &&
			now - state.lastClick.at <= DOUBLE_CLICK_MS &&
			state.lastClick.row === event.row &&
			state.lastClick.column === event.column;
		state.lastClick = { at: now, row: event.row, column: event.column };
		if (doubleClick && host.toggleTranscriptAt(event.row, event.column, mainHeight, panelWidth)) {
			return;
		}
	}

	if (wheelSteps !== 0) {
		const limit = host.maxScroll();
		state.scrollTop = Math.min(limit, Math.max(0, state.scrollTop + wheelSteps * WHEEL_STEP));
		state.follow = state.scrollTop >= limit;
		deps.render();
		return;
	}
	if (dragRow !== undefined) {
		const limit = host.maxScroll();
		state.scrollTop = scrollTopForRow(dragRow, mainHeight, limit);
		state.follow = state.scrollTop >= limit;
		deps.render();
		return;
	}

	const scroll = scrollKey(text);
	if (scroll !== undefined) {
		const limit = host.maxScroll();
		if (scroll === "pageUp") {
			state.scrollTop = Math.max(0, state.scrollTop - mainHeight);
			state.follow = false;
		} else if (scroll === "pageDown") {
			state.scrollTop = Math.min(limit, state.scrollTop + mainHeight);
			state.follow = state.scrollTop >= limit;
		} else {
			state.scrollTop = 0;
			state.follow = false;
		}
		deps.render();
		return;
	}
	if (text === "\x05") {
		if (toggleLastExpandable(state.turns)) {
			markTranscriptDirty(state);
			state.follow = false;
			deps.render();
		}
		return;
	}
	if (text === "\x0f") {
		if (toggleLastToolResult(state.turns)) {
			markTranscriptDirty(state);
			state.follow = false;
			deps.render();
		}
		return;
	}

	const key = approvalKey(text, prompt.saveShort !== undefined);
	if (key === "left") {
		host.moveApprovalSelection(-1);
		return;
	}
	if (key === "right") {
		host.moveApprovalSelection(1);
		return;
	}
	if (key === "enter") {
		host.resolveApproval(state.approvalSelection);
		return;
	}
	if (key === "escape") {
		host.resolveApproval("deny");
		return;
	}
	if (key !== undefined) host.resolveApproval(key);
}

/** 菜单面板的公共鼠标交互:悬停改选、滚轮翻动、点击选中并确认。 */
