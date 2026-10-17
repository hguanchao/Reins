/**
 * 会话主区的横向布局。
 *
 * 主区里每个条目都是一块：最左边一列竖线，正文前留两列、正文后留两列；整块再离终端左右
 * 各两列。右侧那两列留给回合轨道与滚动条，内容宽度因此在所有条目之间保持一致。
 */

/** 整块与终端左右边缘之间的距离。 */
export const OUTER_PAD = 2;

/** 右侧留给轨道与滚动条的列数：轨道两列，滚动条一列。 */
export const GUTTER_WIDTH = 3;

/** 块内最左边的竖线。 */
export const ACCENT_WIDTH = 1;

/** 竖线与正文之间、正文与块右缘之间的留白。 */
export const BLOCK_PAD_LEFT = 2;
export const BLOCK_PAD_RIGHT = 2;

/** 一个块除正文外占掉的列数。 */
export const BLOCK_CHROME = ACCENT_WIDTH + BLOCK_PAD_LEFT + BLOCK_PAD_RIGHT;

/** 正文在一行里的起点：竖线加左留白。 */
export const BLOCK_CONTENT_OFFSET = ACCENT_WIDTH + BLOCK_PAD_LEFT;

/** 正文相对终端左缘的列偏移。 */
export const CONTENT_OFFSET = OUTER_PAD + BLOCK_CONTENT_OFFSET;

/** 给定条目总宽，正文还剩多少列。 */
export function entryContentWidth(entryWidth: number): number {
	return Math.max(1, entryWidth - BLOCK_CHROME);
}
