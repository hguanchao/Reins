import { MOUSE_BUTTON_MASK, MOUSE_MOTION_BIT, MOUSE_WHEEL_BIT, menuIndexAtRow, menuKey } from "./keys.ts";
import type { MenuMouseTarget, MouseInput } from "./keys.ts";
import { type MenuListState, MENU_MAX_VISIBLE, menuListHeight, moveMenuSelection } from "../panel/menu-panel.ts";
import { menuPanelTop } from "../runtime/approval.ts";
import { menuVisibleLimit } from "../runtime/geometry.ts";
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

/** 行内补全面板（命令、文件）与模态面板共用的列表状态：光标直接落在菜单状态上。 */
type MenuTargetState = MenuListState & { readonly items: readonly unknown[] };

export function inlineMenuTarget(
	menu: MenuTargetState,
	panelTop: number,
	panelHeight: number,
	complete: () => void,
	maxVisible = MENU_MAX_VISIBLE,
): MenuMouseTarget {
	return {
		hitItem: (row) =>
			menuIndexAtRow(row, panelTop, menu.items.length, menu.scrollTop, menu.cursor, maxVisible),
		contains: (row) => row >= panelTop && row < panelTop + panelHeight,
		cursor: () => menu.cursor,
		select: (index) => {
			// 点击的是当前窗口里的条目：只移动光标，不把窗口整体滚到该条目的下标处
			moveMenuSelection(menu, index - menu.cursor, menu.items.length, false, maxVisible);
		},
		scroll: (delta) => moveMenuSelection(menu, delta, menu.items.length, false, maxVisible),
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

/** 模态选择面板：只接管选择相关按键，其余放行给输入框。 */
export function handleModalMenuInput(
	host: TuiHost,
	text: string,
	mouseOf: () => readonly MouseInput[],
): boolean {
	const state = host.state;
	// 三种模态面板互斥，列表状态是同一份；鼠标与键盘动作统一走宿主的面板方法
	const menu: MenuTargetState | undefined = state.modelMenu ?? state.effortMenu ?? state.sessionMenu;
	if (menu === undefined) return false;

	// 面板画在页脚区的第一行，命中判定只在这块窗口内有效
	const panelTop = menuPanelTop(state, host.options);
	const limit = menuVisibleLimit(state);
	if (
		handleMenuMouse(
			mouseOf(),
			inlineMenuTarget(
				menu,
				panelTop,
				menuListHeight(menu.items.length, undefined, limit),
				() => host.completeMenu(),
				limit,
			),
			host.render,
		)
	) {
		return true;
	}

	// 会话面板多一个 f：从选中项分叉；分支与历史面板没有这个动作
	if (host.state.sessionMenu !== undefined && (host.state.sessionMenu.kind ?? "sessions") === "sessions" && text === "f") {
		host.forkSelectedSession();
		return true;
	}

	const key = menuKey(text);
	if (key === "up" || key === "down") {
		host.moveMenu(key === "up" ? -1 : 1);
		return true;
	}
	if (key === "enter") {
		host.confirmMenu();
		return true;
	}
	if (key === "tab") {
		// 最后一级面板没有更深的选择：Tab 只补进输入框，不代替回车执行
		host.completeMenu();
		return true;
	}
	if (key === "escape") {
		host.cancelMenu();
		return true;
	}
	// 其余按键放行：打字的瞬间面板会随输入变化收掉
	return false;
}

/** 整屏页：模态的翻页与返回。 */
