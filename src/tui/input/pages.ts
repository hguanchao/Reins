import { MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, menuKey, scrollKey } from "#src/tui/input/keys.ts";
import type { MouseInput } from "#src/tui/input/keys.ts";
import { MCP_ACTION_HEIGHT } from "#src/tui/page/frame.ts";
import { PLAN_ACTION_HEIGHT } from "#src/tui/page/plan.ts";
import { VIEWER_ACTION_HEIGHT } from "#src/tui/page/viewer.ts";
import type { InputDeps } from "#src/tui/input/deps.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

export function handlePageInput(
	host: TuiHost,
	deps: InputDeps,
	text: string,
	mouseOf: () => readonly MouseInput[],
): void {
	const state = host.state;
	const page = state.openPage;
	if (page === undefined) return;
	const key = menuKey(text);
	// 计划审批页先处理自己的三个动作，其余按键仍走通用的翻页规则
	if (page === "plan") {
		if (text === "a") return host.approvePlan();
		if (text === "r") return host.revisePlan();
		if (text === "q") return host.leavePlan();
	}
	if (page === "mcps") {
		if (key === "up" || key === "down") {
			host.moveMcpCursor(key === "up" ? -1 : 1);
			return;
		}
		if (text === "r") return host.reconnectMcp();
		if (text === "h") return host.healthCheckMcp();
		if (key === "escape") {
			state.openPage = undefined;
			state.mcpStatus = undefined;
			state.mcpStatusTone = undefined;
			deps.render();
			return;
		}
	}
	// 整屏页是模态的：上下键与滚轮翻页，Esc 返回，其它按键忽略
	const actionHeight =
		page === "plan"
			? PLAN_ACTION_HEIGHT
			: page === "mcps"
				? MCP_ACTION_HEIGHT
				: page === "viewer"
					? VIEWER_ACTION_HEIGHT
					: 0;
	const rows = Math.max(1, host.mainAreaHeight() - actionHeight);
	const width = host.terminalWidth();
	const total = host.pageLines(page, width).length;
	let steps = 0;
	for (const event of mouseOf()) {
		if (event.press && event.button === MOUSE_WHEEL_UP) steps -= 1;
		else if (event.press && event.button === MOUSE_WHEEL_DOWN) steps += 1;
	}
	if (key === "up") steps -= 1;
	if (key === "down") steps += 1;
	const scroll = scrollKey(text);
	if (scroll === "pageUp") steps -= rows;
	if (scroll === "pageDown") steps += rows;

	if (key === "escape") {
		if (page === "plan") host.closePlanReview();
		else {
			if (page === "viewer") state.viewer = undefined;
			state.openPage = undefined;
		}
		deps.render();
		return;
	}
	if (steps !== 0) {
		state.pageScrollTop = Math.min(Math.max(0, state.pageScrollTop + steps), Math.max(0, total - rows));
		deps.render();
	}
}

/** 对话流与输入框：点击、滚动、补全面板按键与文本编辑。 */
