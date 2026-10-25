import { THINKING_LEVELS } from "../../config/config-file.ts";
import { MOUSE_BUTTON_MASK, MOUSE_WHEEL_DOWN, MOUSE_WHEEL_UP, dragMotion, menuIndexAtRow, menuKey } from "../input.ts";
import type { MenuMouseTarget, MouseInput } from "../input.ts";
import { menuPanelTop } from "./approval.ts";
import type { InputDeps } from "./input.ts";
import type { TuiHost } from "./types.ts";

export function handleMenuMouse(
	events: readonly MouseInput[],
	target: MenuMouseTarget,
	render: () => void,
): boolean {
	for (const event of events) {
		const motion = dragMotion(event.button);
		const index = target.hitItem(event.row);
		if (motion) {
			if (index !== undefined && index !== target.cursor()) {
				target.select(index);
				render();
				return true;
			}
			continue;
		}
		if (event.press && event.button === MOUSE_WHEEL_UP) {
			target.move(-1);
			return true;
		}
		if (event.press && event.button === MOUSE_WHEEL_DOWN) {
			target.move(1);
			return true;
		}
		if (event.press && (event.button & MOUSE_BUTTON_MASK) === 0 && index !== undefined) {
			target.select(index);
			target.confirm();
			return true;
		}
	}
	return false;
}

/** 模态选择面板：只接管选择相关按键，其余放行给输入框。 */
export function handleModalMenuInput(
	host: TuiHost,
	deps: InputDeps,
	text: string,
	mouseOf: () => readonly MouseInput[],
): boolean {
	const state = host.state;
	const panelTop = menuPanelTop(state, host.options);
	if (state.modelMenu !== undefined) {
		const menu = state.modelMenu;
		if (
			handleMenuMouse(
				mouseOf(),
				{
					hitItem: (row) => menuIndexAtRow(row, panelTop, THINKING_LEVELS.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
						menu.scrollTop = Math.max(0, Math.min(index, menu.items.length - 1));
					},
					move: (delta) => host.moveMenu(delta),
					confirm: () => host.confirmMenu(),
				},
				deps.render,
			)
		) {
			return true;
		}
	} else if (state.effortMenu !== undefined) {
		const menu = state.effortMenu;
		if (
			handleMenuMouse(
				mouseOf(),
				{
					hitItem: (row) => menuIndexAtRow(row, panelTop, THINKING_LEVELS.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
					},
					move: (delta) => host.moveEffortMenu(delta),
					confirm: () => host.confirmEffortMenu(),
				},
				deps.render,
			)
		) {
			return true;
		}
	} else if (state.sessionMenu !== undefined) {
		const menu = state.sessionMenu;
		if (
			handleMenuMouse(
				mouseOf(),
				{
					hitItem: (row) => menuIndexAtRow(row, panelTop, THINKING_LEVELS.length, menu.scrollTop, menu.cursor),
					cursor: () => menu.cursor,
					select: (index) => {
						menu.cursor = index;
					},
					move: (delta) => host.moveSessionMenu(delta),
					confirm: () => host.confirmSessionMenu(),
				},
				deps.render,
			)
		) {
			return true;
		}
		if (text === "f") {
			host.forkSelectedSession();
			return true;
		}
	}

	// 键盘同样只差回调:上下移动、回车确认、Tab 补全、Esc 收起
	const key = menuKey(text);
	const panel =
		state.modelMenu !== undefined
			? {
					move: host.moveMenu,
					confirm: host.confirmMenu,
					complete: host.completeModelMenu,
					cancel: host.cancelMenu,
				}
			: state.sessionMenu !== undefined
				? {
						move: host.moveSessionMenu,
						confirm: host.confirmSessionMenu,
						complete: host.completeSessionMenu,
						cancel: host.cancelSessionMenu,
					}
				: {
						move: host.moveEffortMenu,
						confirm: host.confirmEffortMenu,
						complete: host.completeEffortMenu,
						cancel: host.cancelEffortMenu,
					};
	if (key === "up" || key === "down") {
		panel.move(key === "up" ? -1 : 1);
		return true;
	}
	if (key === "enter") {
		panel.confirm();
		return true;
	}
	if (key === "tab") {
		// 最后一级面板没有更深的选择：Tab 只补进输入框，不代替回车执行
		panel.complete();
		return true;
	}
	if (key === "escape") {
		panel.cancel();
		return true;
	}
	// 其余按键放行：打字的瞬间面板会随输入变化收掉
	return false;
}

/** 整屏页：模态的翻页与返回。 */
