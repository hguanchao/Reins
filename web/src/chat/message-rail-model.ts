import type { Line } from "../transcript/lines.ts";

/** 右侧轨迹的一条：会话流下标与提问摘要。 */
export interface UserMessageAnchor {
	readonly index: number;
	readonly text: string;
}

/** 按出现顺序取出用户消息；空白折成单个空格，连续对话里一行只占一条。 */
export function userMessageAnchors(lines: readonly Line[]): readonly UserMessageAnchor[] {
	const anchors: UserMessageAnchor[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line?.kind !== "user") continue;
		anchors.push({ index, text: line.text.replace(/\s+/g, " ").trim() });
	}
	return anchors;
}

/** 刻度条最多露出的条数：再多的提问靠弹出列表自身滚动浏览。 */
export const RAIL_MAX_TICKS = 28;

/** 参与活动判定的一条提问矩形，视口坐标系。 */
export interface AnchorRect {
	readonly index: number;
	readonly top: number;
	readonly bottom: number;
}

/** 视口的可见区间。 */
export interface ViewportSpan {
	readonly top: number;
	readonly bottom: number;
}

/**
 * 当前所在提问：视口上缘越过判定线的最近一条；滚到底时取视口内最靠下的一条；
 * 上方一条都没有时取第一条可见的。
 */
export function pickActiveAnchor(
	rects: readonly AnchorRect[],
	viewport: ViewportSpan,
	atEnd: boolean,
): number | undefined {
	const visible = rects.filter((rect) => rect.bottom > viewport.top && rect.top < viewport.bottom);
	if (visible.length === 0) return undefined;
	if (atEnd) return visible.reduce((a, b) => (b.top > a.top ? b : a)).index;
	const line = viewport.top + 10;
	const crossed = visible.filter((rect) => rect.top <= line);
	const pool = crossed.length > 0 ? crossed : visible;
	return pool.reduce((a, b) => {
		const better = crossed.length > 0 ? b.top >= a.top : b.top <= a.top;
		return better ? b : a;
	}).index;
}

/** 刻度条只保留最近若干个锚点：更早的提问已经不在滚动区首屏，画出来只是噪点。 */
export function visibleTicks(
	anchors: readonly UserMessageAnchor[],
	activeIndex: number | undefined,
	max = RAIL_MAX_TICKS,
): readonly UserMessageAnchor[] {
	if (anchors.length <= max) return anchors;
	const active = anchors.findIndex((anchor) => anchor.index === activeIndex);
	const center = active < 0 ? anchors.length - 1 : active;
	const half = Math.floor(max / 2);
	const start = Math.max(0, Math.min(anchors.length - max, center - half));
	return anchors.slice(start, start + max);
}

/** 展示文本截断；超长以省略号收尾。 */
export function truncateRailText(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
