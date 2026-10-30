import type { ApprovalPrompt } from "#src/permission/approval.ts";
import { MOUSE_BUTTON_MASK, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, approvalKey, dragMotion, menuKey, scrollKey } from "#src/tui/input/keys.ts";
import type { MouseInput } from "#src/tui/input/keys.ts";
import {
	APPROVAL_PANEL_BASE_HEIGHT,
	approvalActionAt,
	approvalPanelHeight,
	approvalPreviewScrollLimit,
} from "#src/tui/panel/approval-panel.ts";
import { WHEEL_STEP } from "#src/tui/runtime/constants.ts";
import {
	applyDragScroll,
	applyWheelScroll,
	handleScrollKey,
	handleToggleKey,
	trackClick,
} from "#src/tui/input/scroll.ts";
import type { InputDeps } from "#src/tui/input/deps.ts";
import type { TuiHost, TuiState } from "#src/tui/runtime/types.ts";

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
	const rows = host.terminalHeight();
	const mainHeight = host.mainAreaHeight();
	const panelTop = host.approvalPanelTop();
	const panelHeight = approvalPanelHeight(prompt, state.approvalExpanded, panelWidth, rows);
	const actionRow = panelTop + panelHeight - 1;
	const detailCapacity = panelHeight - APPROVAL_PANEL_BASE_HEIGHT;
	let wheelSteps = 0;
	let previewSteps = 0;
	let dragRow: number | undefined;

	for (const event of mouseOf()) {
		const motion = dragMotion(event.button);
		const action =
			event.row === actionRow ? approvalActionAt(panelWidth, prompt, event.column - 1) : undefined;
		if (event.press && event.button === MOUSE_WHEEL_UP) {
			// 指针在展开的详情上就滚详情，在对话流上仍滚对话流
			if (state.approvalExpanded && detailCapacity > 0 && event.row > panelTop) previewSteps -= 1;
			else wheelSteps -= 1;
			continue;
		}
		if (event.press && event.button === MOUSE_WHEEL_DOWN) {
			if (state.approvalExpanded && detailCapacity > 0 && event.row > panelTop) previewSteps += 1;
			else wheelSteps += 1;
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

	if (previewSteps !== 0) {
		scrollPreview(state, prompt, panelWidth, rows, previewSteps * WHEEL_STEP);
		deps.render();
		return;
	}
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

	// d 展开/收起详情。收起永远有效；展开只有在确实放得下时才接受，避免按了没反应
	if (text === "d" || text === "D") {
		if (state.approvalExpanded) {
			state.approvalExpanded = false;
			state.approvalScrollTop = 0;
			deps.render();
			return;
		}
		if (approvalPanelHeight(prompt, true, panelWidth, rows) > APPROVAL_PANEL_BASE_HEIGHT) {
			state.approvalExpanded = true;
			state.approvalScrollTop = 0;
			deps.render();
			return;
		}
	}

	// 展开时上下键与翻页键滚详情；否则继续交给对话流的滚动处理
	if (state.approvalExpanded && detailCapacity > 0) {
		const key = menuKey(text);
		const scroll = scrollKey(text);
		const page = Math.max(1, detailCapacity);
		let delta = 0;
		if (key === "up") delta = -1;
		else if (key === "down") delta = 1;
		else if (scroll === "pageUp") delta = -page;
		else if (scroll === "pageDown") delta = page;

		if (delta !== 0) {
			scrollPreview(state, prompt, panelWidth, rows, delta);
			deps.render();
			return;
		}
		if (scroll === "top") {
			state.approvalScrollTop = 0;
			deps.render();
			return;
		}
		if (scroll === "bottom") {
			state.approvalScrollTop = approvalPreviewScrollLimit(prompt, true, panelWidth, rows);
			deps.render();
			return;
		}
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

function scrollPreview(
	state: TuiState,
	prompt: ApprovalPrompt,
	width: number,
	rows: number,
	delta: number,
): void {
	const limit = approvalPreviewScrollLimit(prompt, true, width, rows);
	state.approvalScrollTop = Math.min(limit, Math.max(0, state.approvalScrollTop + delta));
}
