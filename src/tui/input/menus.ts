import { THINKING_LEVELS } from "../../config/file.ts";
import { MOUSE_BUTTON_MASK, MOUSE_MOTION_BIT, MOUSE_WHEEL_BIT, menuIndexAtRow, menuKey } from "./keys.ts";
import type { MenuMouseTarget, MouseInput } from "./keys.ts";
import { moveMenuSelection } from "../panel/menu-panel.ts";
import { effortMenuHeight } from "../panel/effort-menu.ts";
import { modelMenuHeight } from "../panel/model-menu.ts";
import { sessionMenuHeight } from "../panel/session-menu.ts";
import { menuPanelTop } from "../runtime/approval.ts";
import type { TuiHost } from "../runtime/types.ts";

/**
 * 菜单面板的鼠标交互：悬停高亮、按下选中、松开补全。
 *
 * 滚轮只在指针位于面板上时移动选中项，指针在面板外时事件继续交给对话流；
 * 点击必须按下和松开落在同一项上，拖开即取消；补全只改输入框，不执行。
 */
export function handleMenuMouse(
	events: readonly MouseInput[],
	target: MenuMouseTarget,
	render: () => void,
): boolean {
	let handled = false;
	for (const event of events) {
		const wheel = (event.button & MOUSE_WHEEL_BIT) !== 0;
		const motion = (event.button & MOUSE_MOTION_BIT) !== 0 && !wheel;

		if (wheel) {
			if (!event.press || !target.contains(event.row)) continue;
			const button = event.button & MOUSE_BUTTON_MASK;
			if (button > 1) continue;
			target.scroll(button === 0 ? -1 : 1);
			// 列表滚动后，指针下可能已经换成另一项：高亮跟着指针走
			target.setHover(target.hitItem(event.row));
			render();
			handled = true;
			continue;
		}

		// 纯悬停只改高亮，不改选中
		if (motion) {
			if ((event.button & MOUSE_BUTTON_MASK) !== 3) continue;
			if (!target.contains(event.row)) {
				if (target.hover() !== undefined) {
					target.setHover(undefined);
					render();
				}
				continue;
			}
			const index = target.hitItem(event.row);
			if (target.hover() !== index) {
				target.setHover(index);
				render();
			}
			handled = true;
			continue;
		}

		if (!event.press) {
			// 松开：只有按下与松开落在同一项上才算一次点击
			const pressed = target.pressed();
			if (pressed === undefined) continue;
			target.setPressed(undefined);
			target.setHover(undefined);
			if (target.contains(event.row) && target.hitItem(event.row) === pressed) target.complete();
			handled = true;
			continue;
		}

		if ((event.button & MOUSE_BUTTON_MASK) !== 0) continue;

		if (!target.contains(event.row)) {
			if (target.pressed() !== undefined || target.hover() !== undefined) {
				target.setPressed(undefined);
				target.setHover(undefined);
				render();
			}
			continue;
		}

		// 左键按下：只选中并高亮；松开且没有拖开才补全
		const index = target.hitItem(event.row);
		target.setHover(index);
		if (index !== undefined) {
			if (index !== target.cursor()) target.select(index);
			target.setPressed(index);
		} else {
			target.setPressed(undefined);
		}
		render();
		handled = true;
	}
	return handled;
}

/** 行内补全面板（命令、文件）的鼠标目标：光标直接落在菜单状态上，补全交给宿主。 */
interface InlineMenuState {
	readonly items: readonly unknown[];
	cursor: number;
	scrollTop: number;
	hover?: number;
	pressed?: number;
}

export function inlineMenuTarget(
	menu: InlineMenuState,
	panelTop: number,
	panelHeight: number,
	complete: () => void,
): MenuMouseTarget {
	return {
		hitItem: (row) => menuIndexAtRow(row, panelTop, menu.items.length, menu.scrollTop, menu.cursor),
		contains: (row) => row >= panelTop && row < panelTop + panelHeight,
		cursor: () => menu.cursor,
		select: (index) => {
			// 点击的是当前窗口里的条目：只移动光标，不把窗口整体滚到该条目的下标处
			moveMenuSelection(menu, index - menu.cursor, menu.items.length, false);
		},
		scroll: (delta) => moveMenuSelection(menu, delta, menu.items.length, false),
		complete,
		pressed: () => menu.pressed,
		setPressed: (index) => {
			menu.pressed = index;
		},
		hover: () => menu.hover,
		setHover: (index) => {
			menu.hover = index;
		},
	};
}

/** 一个模态菜单的鼠标与键盘回调；三种面板只有这些动作不同。 */
interface ModalMenuActions {
	readonly items: readonly unknown[];
	readonly cursor: () => number;
	readonly scrollTop: () => number;
	readonly select: (index: number) => void;
	readonly move: (delta: number) => void;
	readonly scroll: (delta: number) => void;
	readonly height: () => number;
	readonly confirm: () => void;
	readonly complete: () => void;
	readonly cancel: () => void;
	readonly hover: () => number | undefined;
	readonly setHover: (index: number | undefined) => void;
	readonly pressed: () => number | undefined;
	readonly setPressed: (index: number | undefined) => void;
}

/** 当前打开的是哪个模态菜单；三者互斥，返回 undefined 表示没有。 */
function activeModalMenu(host: TuiHost): ModalMenuActions | undefined {
	const state = host.state;
	if (state.modelMenu !== undefined) {
		const menu = state.modelMenu;
		return {
			items: menu.items,
			cursor: () => menu.cursor,
			scrollTop: () => menu.scrollTop,
			select: (index) => {
				moveMenuSelection(menu, index - menu.cursor, menu.items.length, false);
			},
			move: (delta) => host.moveMenu(delta),
			scroll: (delta) => moveMenuSelection(menu, delta, menu.items.length, false),
			height: () => modelMenuHeight(menu.items.length),
			confirm: () => host.confirmMenu(),
			complete: () => host.completeModelMenu(),
			cancel: () => host.cancelMenu(),
			hover: () => menu.hover,
			setHover: (index) => {
				menu.hover = index;
			},
			pressed: () => menu.pressed,
			setPressed: (index) => {
				menu.pressed = index;
			},
		};
	}
	if (state.effortMenu !== undefined) {
		const menu = state.effortMenu;
		return {
			items: THINKING_LEVELS,
			cursor: () => menu.cursor,
			scrollTop: () => menu.scrollTop,
			select: (index) => {
				moveMenuSelection(menu, index - menu.cursor, THINKING_LEVELS.length, false);
			},
			move: (delta) => host.moveEffortMenu(delta),
			scroll: (delta) => moveMenuSelection(menu, delta, THINKING_LEVELS.length, false),
			height: () => effortMenuHeight(),
			confirm: () => host.confirmEffortMenu(),
			complete: () => host.completeEffortMenu(),
			cancel: () => host.cancelEffortMenu(),
			hover: () => menu.hover,
			setHover: (index) => {
				menu.hover = index;
			},
			pressed: () => menu.pressed,
			setPressed: (index) => {
				menu.pressed = index;
			},
		};
	}
	if (state.sessionMenu !== undefined) {
		const menu = state.sessionMenu;
		return {
			items: menu.items,
			cursor: () => menu.cursor,
			scrollTop: () => menu.scrollTop,
			select: (index) => {
				moveMenuSelection(menu, index - menu.cursor, menu.items.length, false);
			},
			move: (delta) => host.moveSessionMenu(delta),
			scroll: (delta) => moveMenuSelection(menu, delta, menu.items.length, false),
			height: () => sessionMenuHeight(menu.items.length, host.options.sessionMenu?.fork !== undefined),
			confirm: () => host.confirmSessionMenu(),
			complete: () => host.completeSessionMenu(),
			cancel: () => host.cancelSessionMenu(),
			hover: () => menu.hover,
			setHover: (index) => {
				menu.hover = index;
			},
			pressed: () => menu.pressed,
			setPressed: (index) => {
				menu.pressed = index;
			},
		};
	}
	return undefined;
}

/** 模态选择面板：只接管选择相关按键，其余放行给输入框。 */
export function handleModalMenuInput(
	host: TuiHost,
	text: string,
	mouseOf: () => readonly MouseInput[],
): boolean {
	const panel = activeModalMenu(host);
	if (panel === undefined) return false;

	// 面板画在页脚区的第一行，命中判定只在这块窗口内有效
	const panelTop = menuPanelTop(host.state, host.options);
	if (
		handleMenuMouse(
			mouseOf(),
			{
				hitItem: (row) =>
					menuIndexAtRow(row, panelTop, panel.items.length, panel.scrollTop(), panel.cursor()),
				contains: (row) => row >= panelTop && row < panelTop + panel.height(),
				cursor: panel.cursor,
				select: panel.select,
				scroll: panel.scroll,
				complete: panel.complete,
				pressed: panel.pressed,
				setPressed: panel.setPressed,
				hover: panel.hover,
				setHover: panel.setHover,
			},
			host.render,
		)
	) {
		return true;
	}

	// 会话面板多一个 f：从选中项分叉
	if (host.state.sessionMenu !== undefined && text === "f") {
		host.forkSelectedSession();
		return true;
	}

	const key = menuKey(text);
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
