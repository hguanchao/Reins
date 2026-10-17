import type { Span } from "../../tui/index.ts";
import { SCROLL_THUMB, SCROLL_TRACK } from "./theme.ts";

/**
 * 会话区右侧的滚动条。
 *
 * 滑块的高度按「可见行数 / 总行数」算，位置直接由视口顶端映射过来。它只负责显示和把鼠标
 * 行换算成视口行号，真正的滚动状态仍由 Viewport 持有。轨道只是一层比屏幕底色更暗的底色，
 * 滑块浮在上面——滚动条应当被余光看见，而不是注视。
 */

/** 滚动条占的列数。 */
export const SCROLLBAR_WIDTH = 1;

/** 滑块在轨道里的位置；`size === 0` 表示内容不足一屏，不画滚动条。 */
export interface ScrollbarState {
	readonly top: number;
	readonly size: number;
	readonly maxTop: number;
	readonly maxScroll: number;
}

export function scrollbarState(total: number, height: number, start: number): ScrollbarState {
	if (total <= height || height <= 0) return { top: 0, size: 0, maxTop: 0, maxScroll: 0 };

	// 滑块至少一格；内容越长，滑块越短
	const size = Math.max(1, Math.round((height * height) / total));
	const maxTop = Math.max(0, height - size);
	const maxScroll = Math.max(0, total - height);
	const top =
		maxScroll === 0
			? 0
			: Math.min(maxTop, Math.round((Math.min(maxScroll, Math.max(0, start)) / maxScroll) * maxTop));
	return { top, size, maxTop, maxScroll };
}

/** 某一行的滚动条格子：滑块是实心块，轨道只铺一层更暗的底色。 */
export function scrollbarCell(row: number, total: number, height: number, start: number): Span {
	const state = scrollbarState(total, height, start);
	if (state.size === 0) return { text: " " };
	return row >= state.top && row < state.top + state.size
		? { text: "█", style: SCROLL_THUMB }
		: { text: " ", style: SCROLL_TRACK };
}

/**
 * 鼠标按在滚动条上时，抓点离滑块顶端的距离。
 *
 * 按在滑块上就直接抓那一格；按在轨道上则把滑块中心移到按下的位置，返回中心偏移。
 */
export function scrollbarGrabOffset(row: number, total: number, height: number, start: number): number | undefined {
	const state = scrollbarState(total, height, start);
	if (state.size === 0) return undefined;
	if (row >= state.top && row < state.top + state.size) return row - state.top;
	return Math.floor(state.size / 2);
}

/** 把拖动到的行换算成视口顶端行号。 */
export function scrollbarStart(row: number, grab: number, total: number, height: number): number {
	const state = scrollbarState(total, height, 0);
	if (state.size === 0 || state.maxTop === 0) return 0;
	const top = Math.max(0, Math.min(state.maxTop, row - grab));
	return Math.round((top / state.maxTop) * state.maxScroll);
}
