/** 三栏骨架的宽度求解；纯函数，便于独立验证窗口收放规则。 */

export interface ColumnWidths {
	readonly sidebar: number;
	readonly center: number;
	readonly rightbar: number;
}

export const SIDEBAR_DEFAULT = 280;
export const SIDEBAR_MIN = 264;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_COLLAPSED = 0;
export const SIDEBAR_AUTO_COLLAPSE = 1024;
export const CENTER_MIN = 400;
export const RIGHTBAR_MIN = 300;
export const RIGHTBAR_DEFAULT_RATIO = 0.45;
export const RIGHTBAR_MAX_RATIO = 0.7;

export function clampSidebar(width: number): number {
	return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

export function defaultRightbarWidth(viewport: number): number {
	return Math.round(viewport * RIGHTBAR_DEFAULT_RATIO);
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
			: Math.min(available, Math.round(Math.min(width * RIGHTBAR_MAX_RATIO, Math.max(RIGHTBAR_MIN, rightbar))));
	return {
		sidebar: resolvedSidebar,
		center: Math.max(0, width - resolvedSidebar - resolvedRight),
		rightbar: resolvedRight,
	};
}
