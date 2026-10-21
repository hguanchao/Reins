import { displayWidth } from "./menu-panel.ts";
import { THEME } from "./theme.ts";

/**
 * 对话流右下角的置底按钮。
 *
 * 只在上滚离开底部时出现：用一行高的浮层盖住对话流最后一行右端，不占布局高度，因此不需要
 * 改动任何高度与行号计算。右端留出最后一列给滚动条，两者不会叠在一起。
 */

/** 符号两侧各留两列内边距：单行小目标用鼠标很难点中，胶囊要做得比符号本身宽。 */
const LABEL = "  ▼  ";
/** 命中区在按钮左侧再放宽一列；右侧紧挨滚动条，不再外扩。 */
const HIT_SLOP = 1;
/** 默认弱色：不跟正文抢注意力；指针移上来才用强调色，说明这里可以点。 */
const IDLE_COLOR = THEME.textSubtle;
const HOVER_COLOR = THEME.accent;

export interface ScrollButtonPlacement {
	/** 1 基屏幕行 */
	readonly row: number;
	/** 1 基起始列 */
	readonly column: number;
	/** 显示宽度 */
	readonly width: number;
	/** 已带颜色转义的整段文本 */
	readonly text: string;
	/** 命中区左边界，比按钮本身宽出一列 */
	readonly hitColumn: number;
	/** 命中区宽度 */
	readonly hitWidth: number;
}

/**
 * 按钮的位置；终端放不下时返回 undefined。
 *
 * 宽度按显示宽度算，符号或内边距换成宽字符也不会把右侧顶到滚动条上。按钮左侧至少留一列正文，
 * 否则整行被盖满，就看不出这是浮层而不是正文。highlighted 只换符号颜色，位置与命中区不变，
 * 因此指针在按钮上移动时不会因为宽度变化而闪。
 */
export function scrollButtonPlacement(
	width: number,
	height: number,
	highlighted = false,
): ScrollButtonPlacement | undefined {
	const columns = Math.max(0, width);
	const rows = Math.max(0, height);
	const labelWidth = displayWidth(LABEL);
	if (rows === 0 || columns < labelWidth + 2) return undefined;

	// 右边界停在 columns - 1，最后一列始终是滚动条
	const column = columns - labelWidth;
	const hitColumn = Math.max(1, column - HIT_SLOP);
	return {
		row: rows,
		column,
		width: labelWidth,
		text: `${THEME.surface}${highlighted ? HOVER_COLOR : IDLE_COLOR}${LABEL}${THEME.reset}`,
		hitColumn,
		hitWidth: column + labelWidth - hitColumn,
	};
}

/** 命中的屏幕坐标是否落在按钮上；行列都从 1 起算，右边界不含。 */
export function scrollButtonHit(
	placement: ScrollButtonPlacement,
	row: number,
	column: number,
): boolean {
	return (
		row === placement.row &&
		column >= placement.hitColumn &&
		column < placement.hitColumn + placement.hitWidth
	);
}
