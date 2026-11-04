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

/** 收起刻度的间距与首条中心：刻度条是一串等距短横线。 */
export const RAIL_TICK_STEP = 14;
export const RAIL_TICK_FIRST = 17;
/** 展开列表的行距与行高：行比行距矮 2px，形成行间空隙。 */
export const RAIL_ROW_STEP = 28;
export const RAIL_ROW_HEIGHT = 26;
export const RAIL_ROW_FIRST = 21;
/** 刻度带与列表各自的上下留白。 */
export const RAIL_BAND_PAD = 20;
export const RAIL_LIST_PAD = 16;
/** 刻度条最多露出的条数与面板的最大高度：再多的提问靠列表滚动浏览。 */
export const RAIL_MAX_TICKS = 28;
export const RAIL_MAX_EXPANDED_HEIGHT = 400;

/** 轨迹两套布局共用的几何：面板尺寸、裁切边距与列表内容高全部由条数推出。 */
export interface RailMetrics {
	/** 轨迹整体高度，收起刻度条与展开面板取较大者。 */
	readonly outerHeight: number;
	/** 收起时刻度条的可见高度。 */
	readonly compactHeight: number;
	/** 收起态刻度带的内容总高，超出面板高度时列表可滚。 */
	readonly compactContentHeight: number;
	/** 刻度带在列表内容里的起始偏移，展开内容更高时用于垂直居中。 */
	readonly compactOffset: number;
	/** 列表内容总高，两套布局取较大者。 */
	readonly rowsHeight: number;
	/** 收起裁切的上下边距，只露出居中的刻度条。 */
	readonly closedInsetY: number;
	/** 展开面板的上下边距。 */
	readonly openInsetY: number;
	/** 展开面板高度。 */
	readonly expandedHeight: number;
}

/** 由提问条数推出全部几何；没有提问时无需渲染。 */
export function railMetrics(count: number): RailMetrics | undefined {
	if (count <= 0) return undefined;
	const compactContentHeight = count * RAIL_TICK_STEP + RAIL_BAND_PAD;
	const compactHeight = Math.min(count, RAIL_MAX_TICKS) * RAIL_TICK_STEP + RAIL_BAND_PAD;
	const expandedNatural =
		count * RAIL_ROW_HEIGHT + Math.max(0, count - 1) * (RAIL_ROW_STEP - RAIL_ROW_HEIGHT) + RAIL_LIST_PAD;
	const expandedHeight = Math.min(RAIL_MAX_EXPANDED_HEIGHT, expandedNatural);
	const outerHeight = Math.max(compactHeight, expandedHeight);
	const compactOffset = Math.max(0, (expandedHeight - compactContentHeight) / 2);
	const rowsHeight = Math.max(compactContentHeight, expandedNatural);
	const bandCenter = ((Math.min(count, RAIL_MAX_TICKS) - 1) * RAIL_TICK_STEP) / 2 + RAIL_TICK_FIRST;
	const closedInsetY = Math.max(0, outerHeight / 2 - bandCenter);
	const openInsetY = (outerHeight - expandedHeight) / 2;
	return {
		outerHeight,
		compactHeight,
		compactContentHeight,
		compactOffset,
		rowsHeight,
		closedInsetY,
		openInsetY,
		expandedHeight,
	};
}

/** 收起态第 position 条刻度的中心 Y（列表内容坐标）。 */
export function tickCenterY(metrics: RailMetrics, position: number): number {
	return metrics.compactOffset + RAIL_TICK_FIRST + position * RAIL_TICK_STEP;
}

/** 展开态第 position 行的中心 Y（列表内容坐标）。 */
export function rowCenterY(position: number): number {
	return RAIL_ROW_FIRST + position * RAIL_ROW_STEP;
}

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

/** 展开瞬间的滚动计划：目标滚动位与垫住条目的位移差值。 */
export interface OpenScrollPlan {
	readonly scrollTop: number;
	readonly visualOffset: number;
}

/**
 * 展开时把列表滚到「当前提问在展开布局里仍停在原屏幕位置」的位置；
 * 差值交给位移变量在动画期间垫住，动画结束后一次性提交滚动，条目才不会跳。
 */
export function planOpenScroll(input: {
	readonly activeIndex: number;
	readonly activeScreenY: number;
	readonly compactScrollTop: number;
	readonly maxScroll: number;
}): OpenScrollPlan {
	const maxScroll = Math.max(0, input.maxScroll);
	const scrollTop = Math.min(maxScroll, Math.max(0, rowCenterY(input.activeIndex) - input.activeScreenY));
	return { scrollTop, visualOffset: input.compactScrollTop - scrollTop };
}

/** 收起列表里让当前刻度保持居中的滚动位；已居中（±1px）则维持原位。 */
export function compactScrollTopFor(input: {
	readonly activeIndex: number;
	readonly compactOffset: number;
	readonly current: number;
	readonly clientHeight: number;
	readonly contentHeight: number;
}): number {
	const center = input.compactOffset + RAIL_TICK_FIRST + input.activeIndex * RAIL_TICK_STEP;
	if (center - 1 >= input.current && center + 1 <= input.current + input.clientHeight) return input.current;
	const maxScroll = Math.max(0, input.contentHeight - input.clientHeight);
	return Math.min(maxScroll, Math.max(0, center - input.clientHeight / 2));
}

/** 展示文本截断；超长以省略号收尾。 */
export function truncateRailText(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 估算单行显示宽度：宽字符记 2、其余记 1，只用于挑量宽样本，不求精确。 */
export function estimateRailTextWidth(text: string): number {
	let width = 0;
	for (let index = 0; index < text.length; index += 1) width += text.charCodeAt(index) > 0x2e7f ? 2 : 1;
	return width;
}

/**
 * 面板宽度由最宽的几条提问撑出；只挑有限条参与量宽，长会话不必全部白算。
 * 样本先按上限截断，再按估算宽度取最宽的若干条。
 */
export function selectRailSizerTexts(
	texts: readonly string[],
	samples: number,
	limit: number,
): readonly string[] {
	const truncated = texts.map((text) => truncateRailText(text, limit));
	if (truncated.length <= samples) return truncated;
	return truncated
		.map((text) => ({ text, width: estimateRailTextWidth(text) }))
		.sort((a, b) => b.width - a.width)
		.slice(0, samples)
		.map((entry) => entry.text);
}
