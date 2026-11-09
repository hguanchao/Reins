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
/** 设计稿在 1180px 以下把侧栏收到 210px，这里放宽到 240px：窄窗下文字不再频繁截断。 */
export const NARROW_WINDOW = 1180;
export const SIDEBAR_NARROW = 240;
/** 设计稿在 900px 以下把侧栏与面板整条藏掉，JS 列宽走同一断点。 */
export const COMPACT_WINDOW = 900;
export const CENTER_MIN = 400;
export const RIGHTBAR_MIN = 300;
export const RIGHTBAR_DEFAULT = 308;
export const RIGHTBAR_MAX = 420;
export const RIGHTBAR_MAX_RATIO = 0.7;

export function clampSidebar(width: number): number {
	return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
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
 * 900px 以下与设计稿一致：侧栏与面板整条隐藏。
 * `sidebar` 传 0 表示收起，`rightbar` 传 0 表示未打开。
 */
export function computeColumns(viewport: number, sidebar: number, rightbar: number): ColumnWidths {
	const width = Math.max(0, Math.round(viewport));
	if (width <= COMPACT_WINDOW) {
		return { sidebar: 0, center: width, rightbar: 0 };
	}
	const rawSidebar = sidebar <= 0 ? SIDEBAR_COLLAPSED : clampSidebar(sidebar);
	// 媒体查询改的 --sb-w 管不到 JS 算出来的列宽，这里补上同样的收敛规则
	const resolvedSidebar = width <= NARROW_WINDOW ? Math.min(rawSidebar, SIDEBAR_NARROW) : rawSidebar;
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
