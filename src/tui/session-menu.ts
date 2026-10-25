import { displayWidth, fitToWidth, truncateToWidth } from "./text.ts";
import {
	ACCENT_COLOR,
	BOLD_OFF,
	MENU_MAX_VISIBLE,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	SUBTLE_COLOR,
	TEXT_COLOR,
	bottomBorder,
	keepVisible,
	menuHeight,
	padEnd,
	topBorder,
} from "./menu-panel.ts";

/**
 * 会话选择面板。
 *
 * 每行四段：会话标识、会话标题、最近活动时间、当前会话标记，段与段之间固定两列。
 * 标识与时间按内容定宽，标题吃剩余宽度；current 只贴在时间之后，不右对齐到面板边缘——
 * 它属于这一行的信息，离时间越近越容易读成一行。
 */

export interface SessionMenuItem {
	readonly id: string;
	readonly title: string;
	/** 最近活动时间的人话表示，例如 "2 hours ago"；空串表示不显示 */
	readonly time: string;
	readonly current: boolean;
	/** 分叉来源的标题；有值时标题显示成「↳ Fork of …」 */
	readonly forkedFrom?: string;
}

export interface SessionMenuState {
	readonly items: readonly SessionMenuItem[];
	cursor: number;
	scrollTop: number;
}

const SESSION_MENU_MAX_VISIBLE = MENU_MAX_VISIBLE;

/** " › " 的显示宽度；未选中行用等宽空格占位。 */
const PREFIX_WIDTH = 3;
/** 段间距。固定四列，不随内容长度变化。 */
const GAP = "    ";
const GAP_WIDTH = 4;
/** 会话标识是 16 位十六进制；文件里读到更长的也不无限占列。 */
const MAX_ID_WIDTH = 16;
/** 时间列最宽到这里为止，再长就把标题挤没了。 */
const MAX_TIME_WIDTH = 16;
/** "current" 的显示宽度。 */
const CURRENT_WIDTH = 7;
/** 标题少于这么多列就不显示，把宽度还给标识与时间。 */
const MIN_TITLE_WIDTH = 8;

export function sessionMenuHeight(itemCount: number, forkAvailable = false): number {
	return menuHeight(itemCount) + (forkAvailable ? 1 : 0);
}

export function renderSessionMenu(
	width: number,
	state: SessionMenuState,
	forkAvailable = false,
): readonly string[] {
	const items = state.items;
	const visibleCount = Math.min(items.length, SESSION_MENU_MAX_VISIBLE);
	const top = keepVisible(state.scrollTop, state.cursor, items.length);
	const layout = layoutColumns(width, items);
	const lines: string[] = [topBorder(width, items.length)];

	for (let offset = 0; offset < visibleCount; offset += 1) {
		const item = items[top + offset];
		if (item === undefined) break;
		lines.push(row(width, item, top + offset === state.cursor, layout));
	}

	lines.push(bottomBorder(width));
	if (forkAvailable) lines.push(actionHint(width));
	return lines;
}

/** 面板底部的一行动作提示；分叉不可用时只说切换与关闭。 */
function actionHint(width: number): string {
	const text = truncateToWidth("  Enter switch   f fork at end   Esc close", width);
	return `${PANEL_BG}${SUBTLE_COLOR}${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}${RESET}`;
}

interface Columns {
	readonly idWidth: number;
	/** 标题最多占多少列；0 表示终端太窄，标题不显示 */
	readonly titleWidth: number;
	/** 0 表示终端太窄，时间不显示 */
	readonly timeWidth: number;
	/** 是否显示 current 标记；窄到放不下标识时就该让位 */
	readonly showCurrent: boolean;
}

function layoutColumns(width: number, items: readonly SessionMenuItem[]): Columns {
	const longestId = Math.max(1, ...items.map((item) => displayWidth(item.id)));
	const longestTitle = Math.max(0, ...items.map((item) => displayWidth(titleOf(item))));
	const longestTime = Math.max(0, ...items.map((item) => displayWidth(item.time)));

	// 标识是唯一能指向具体会话的信息，最后才动它；终端窄到放不下时只能截
	const idWidth = Math.min(longestId, MAX_ID_WIDTH, Math.max(1, width - PREFIX_WIDTH));
	const timeWidth = Math.min(longestTime, MAX_TIME_WIDTH);
	// 除标题外，其余各段占掉的宽度：标识、三处间距（标题前、时间前、current 前）、时间、current
	const fixed = PREFIX_WIDTH + idWidth + GAP_WIDTH * 3 + timeWidth + CURRENT_WIDTH;

	// 按优先级依次尝试，取第一个放得下的组合：
	// 完整一行 → 舍 current → 舍标题 → 舍时间 → 只剩标识
	const forTitleWithCurrent = width - fixed;
	if (forTitleWithCurrent >= MIN_TITLE_WIDTH) {
		return { idWidth, titleWidth: Math.min(longestTitle, forTitleWithCurrent), timeWidth, showCurrent: true };
	}

	const forTitle = width - fixed + CURRENT_WIDTH + GAP_WIDTH;
	if (forTitle >= MIN_TITLE_WIDTH) {
		return { idWidth, titleWidth: Math.min(longestTitle, forTitle), timeWidth, showCurrent: false };
	}

	const forTimeWithoutTitle = width - PREFIX_WIDTH - idWidth - GAP_WIDTH;
	if (forTimeWithoutTitle >= 1) {
		return { idWidth, titleWidth: 0, timeWidth: Math.min(timeWidth, forTimeWithoutTitle), showCurrent: false };
	}

	return { idWidth, titleWidth: 0, timeWidth: 0, showCurrent: false };
}

/** 列表里显示的标题：分叉会话把来源带在标题里，不用再占一行。 */
function titleOf(item: SessionMenuItem): string {
	return item.forkedFrom === undefined ? item.title : `↳ Fork of ${item.forkedFrom}`;
}

function row(width: number, item: SessionMenuItem, selected: boolean, columns: Columns): string {
	const primaryColor = selected ? SELECTED_TEXT_COLOR : TEXT_COLOR;
	const boldOff = selected ? BOLD_OFF : "";
	const prefix = selected ? " › " : "   ";

	// 每段补齐到列宽，各列起点才对得齐；只有 current 在行尾，不需要补
	const idText = padEnd(item.id, columns.idWidth);
	const titleText = columns.titleWidth > 0 ? padEnd(fitToWidth(titleOf(item), columns.titleWidth), columns.titleWidth) : "";
	const timeText = columns.timeWidth > 0 ? padEnd(fitToWidth(item.time, columns.timeWidth), columns.timeWidth) : "";
	const currentText = item.current && columns.showCurrent ? "current" : "";

	// 先按纯文本拼一遍算宽度：颜色转义序列也算字符，直接量带色的字符串会少补白，
	// 行底色就只铺到文字末尾
	const plain =
		prefix +
		idText +
		(titleText.length > 0 ? GAP + titleText : "") +
		(timeText.length > 0 ? GAP + timeText : "") +
		(currentText.length > 0 ? GAP + currentText : "");
	const padding = " ".repeat(Math.max(0, width - displayWidth(plain)));

	const prefixOutput = selected ? ` ${ACCENT_COLOR}›${primaryColor} ` : prefix;
	const id = `${MUTED_COLOR}${idText}`;
	const title = titleText.length > 0 ? `${GAP}${primaryColor}${titleText}` : "";
	const time = timeText.length > 0 ? `${GAP}${MUTED_COLOR}${timeText}` : "";
	const current = currentText.length > 0 ? `${GAP}${ACCENT_COLOR}${currentText}` : "";

	return `${PANEL_BG}${primaryColor}${prefixOutput}${id}${title}${time}${current}${boldOff}${padding}${RESET}`;
}
