import { THINKING_LEVELS } from "../../config/file.ts";
import { MOUSE_BUTTON_MASK, MOUSE_MOTION_BIT, MOUSE_WHEEL_BIT, menuIndexAtRow, menuKey } from "./keys.ts";
import type { MenuMouseTarget, MouseInput } from "./keys.ts";
import { menuPanelTop } from "../runtime/approval.ts";
import type { TuiHost } from "../runtime/types.ts";

/**
 * 菜单面板的鼠标交互：只认左键点击条目。
 *
 * 悬停与拖动只是指针在移动，不改选中；滚轮向上（64）的低两位同样是 0，不单独排掉会被
 * 当成左键。点击把该项补进输入框而不是执行，避免一次误点就把模型或会话换掉。
 */
export function handleMenuMouse(
	events: readonly MouseInput[],
	target: MenuMouseTarget,
): boolean {
	for (const event of events) {
		if (!event.press) continue;
		// 移动位或滚轮位置位时，这次上报不是「按下左键」
		if ((event.button & MOUSE_MOTION_BIT) !== 0 || (event.button & MOUSE_WHEEL_BIT) !== 0) continue;
		if ((event.button & MOUSE_BUTTON_MASK) !== 0) continue;

		const index = target.hitItem(event.row);
		if (index === undefined) continue;
		if (index !== target.cursor()) target.select(index);
		target.complete();
		return true;
	}
	return false;
}

/** 行内补全面板（命令、文件）的鼠标目标：光标直接落在菜单状态上，补全交给宿主。 */
interface InlineMenuState {
	readonly items: readonly unknown[];
	cursor: number;
	scrollTop: number;
}

export function inlineMenuTarget(
	menu: InlineMenuState,
	panelTop: number,
	complete: () => void,
): MenuMouseTarget {
	return {
		hitItem: (row) => menuIndexAtRow(row, panelTop, menu.items.length, menu.scrollTop, menu.cursor),
		cursor: () => menu.cursor,
		select: (index) => {
			menu.cursor = index;
			menu.scrollTop = Math.max(0, Math.min(index, menu.items.length - 1));
		},
		complete,
	};
}

/** 一个模态菜单的鼠标与键盘回调；三种面板只有这些动作不同。 */
interface ModalMenuActions {
	readonly items: readonly unknown[];
	readonly cursor: () => number;
	readonly scrollTop: () => number;
	readonly select: (index: number) => void;
	readonly move: (delta: number) => void;
	readonly confirm: () => void;
	readonly complete: () => void;
	readonly cancel: () => void;
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
				menu.cursor = index;
				menu.scrollTop = Math.max(0, Math.min(index, menu.items.length - 1));
			},
			move: (delta) => host.moveMenu(delta),
			confirm: () => host.confirmMenu(),
			complete: () => host.completeModelMenu(),
			cancel: () => host.cancelMenu(),
		};
	}
	if (state.effortMenu !== undefined) {
		const menu = state.effortMenu;
		return {
			items: THINKING_LEVELS,
			cursor: () => menu.cursor,
			scrollTop: () => menu.scrollTop,
			select: (index) => {
				menu.cursor = index;
			},
			move: (delta) => host.moveEffortMenu(delta),
			confirm: () => host.confirmEffortMenu(),
			complete: () => host.completeEffortMenu(),
			cancel: () => host.cancelEffortMenu(),
		};
	}
	if (state.sessionMenu !== undefined) {
		const menu = state.sessionMenu;
		return {
			items: menu.items,
			cursor: () => menu.cursor,
			scrollTop: () => menu.scrollTop,
			select: (index) => {
				menu.cursor = index;
			},
			move: (delta) => host.moveSessionMenu(delta),
			confirm: () => host.confirmSessionMenu(),
			complete: () => host.completeSessionMenu(),
			cancel: () => host.cancelSessionMenu(),
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
		handleMenuMouse(mouseOf(), {
			hitItem: (row) =>
				menuIndexAtRow(row, panelTop, panel.items.length, panel.scrollTop(), panel.cursor()),
			cursor: panel.cursor,
			select: panel.select,
			complete: panel.complete,
		})
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
