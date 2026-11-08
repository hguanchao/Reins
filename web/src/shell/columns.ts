/** 三栏骨架的宽度求解；纯函数，便于独立验证窗口收放规则。 */

export interface ColumnWidths {
	readonly sidebar: number;
	readonly center: number;
	readonly rightbar: number;
}

/** demo 基准：侧栏 244px 可拖 180–320px，右面板 308px 可拖 300–420px。 */
export const SIDEBAR_DEFAULT = 244;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 320;
export const SIDEBAR_COLLAPSED = 0;
export const SIDEBAR_AUTO_COLLAPSE = 1024;
/** 展开比收起高一档余量:拖拽在阈值附近晃动时不会收了又展、展了又收 */
export const SIDEBAR_AUTO_EXPAND = SIDEBAR_AUTO_COLLAPSE + 64;
export const CENTER_MIN = 400;
export const RIGHTBAR_MIN = 300;
export const RIGHTBAR_DEFAULT = 308;
export const RIGHTBAR_MAX = 420;
export const RIGHTBAR_MAX_RATIO = 0.7;

export function clampSidebar(width: number): number {
	return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

/**
 * 窗口宽度变化后的侧栏动作：true 收起、false 展开、undefined 维持现状。
 *
 * 收起即时——迟疑的每一帧里侧栏都还占着 280px，中间列被挤到变形；展开滞后一档余量，
 * 拖拽在阈值附近晃动时不会收了又展、展了又收。用户亲手收起的不代劳。
 */
export function autoSidebarAction(
	innerWidth: number,
	collapsed: boolean,
	autoCollapsed: boolean,
): boolean | undefined {
	if (innerWidth < SIDEBAR_AUTO_COLLAPSE) return collapsed ? undefined : true;
	return autoCollapsed && innerWidth >= SIDEBAR_AUTO_EXPAND ? false : undefined;
}

/** 右面板默认宽度跟着 demo 的 308px，窄窗时才让位。 */
export function defaultRightbarWidth(viewport: number): number {
	return Math.round(Math.min(RIGHTBAR_DEFAULT, viewport * RIGHTBAR_MAX_RATIO));
}

/** 拖拽右栏时的收敛：下限 300、上限 420，且不超过窗口 70%。 */
export function clampRightbar(width: number, viewport: number): number {
	return Math.round(
		Math.min(RIGHTBAR_MAX, Math.min(viewport * RIGHTBAR_MAX_RATIO, Math.max(RIGHTBAR_MIN, width))),
	);
}

/**
 * 右栏先让位，再允许主列被压缩；侧栏只按自己的上下限收敛。
 * `sidebar` 传 0 表示收起，`rightbar` 传 0 表示未打开。
 */
export function computeColumns(viewport: number, sidebar: number, rightbar: number): ColumnWidths {
	const width = Math.max(0, Math.round(viewport));
	const resolvedSidebar = sidebar <= 0 ? SIDEBAR_COLLAPSED : clampSidebar(sidebar);
	const available = width - resolvedSidebar - CENTER_MIN;
	const resolvedRight =
		rightbar <= 0 || available < RIGHTBAR_MIN
			? 0
			: Math.min(available, clampRightbar(rightbar, width));
	return {
		sidebar: resolvedSidebar,
		center: Math.max(0, width - resolvedSidebar - resolvedRight),
		rightbar: resolvedRight,
	};
}
