import { MOUSE_BUTTON_MASK, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, approvalKey, dragMotion } from "./keys.ts";
import type { MouseInput } from "./keys.ts";
import { approvalActionAt } from "../panel/approval-panel.ts";
import {
	applyDragScroll,
	applyWheelScroll,
	handleScrollKey,
	handleToggleKey,
	trackClick,
} from "./scroll.ts";
import type { InputDeps } from "./deps.ts";
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

		if (trackClick(state, event) && host.toggleTranscriptAt(event.row, event.column, mainHeight, panelWidth)) {
			return;
		}
	}

	// 审批卡在场时滚轮与拖动只用来滚对话流：它们处理过之后，同一块里的按键不再往下走
	if (wheelSteps !== 0) {
		applyWheelScroll(host, state, wheelSteps);
		deps.render();
		return;
	}
	if (dragRow !== undefined) {
		applyDragScroll(host, state, dragRow, mainHeight);
		deps.render();
		return;
	}
	if (handleScrollKey(host, state, text, mainHeight) || handleToggleKey(state, text)) {
		deps.render();
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
