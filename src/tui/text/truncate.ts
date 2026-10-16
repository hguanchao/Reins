import { cellsOf, lineOfCells, sumCellsWidth, type Cell, type Line } from "./line.ts";

/**
 * 按列宽截断。
 *
 * 省略号是行为的一部分：只截断不提示，使用者会以为句子本来就这么短。末尾的省略号占一列，
 * 因此可用宽度要留出它。
 */

export const ELLIPSIS = "…";

/** 按列宽裁掉放不下的格子，不加省略号。宽度不含宽字符劈成两半的情况：宁可少放一个。 */
export function fitCells(cells: readonly Cell[], width: number): readonly Cell[] {
	if (width <= 0) return [];
	const kept: Cell[] = [];
	let used = 0;
	for (const cell of cells) {
		if (used + cell.width > width) break;
		kept.push(cell);
		used += cell.width;
	}
	return kept;
}

/** 整体宽度不超过给定值，放不下时末尾补省略号。 */
export function truncateCells(cells: readonly Cell[], width: number): readonly Cell[] {
	if (width <= 0) return [];
	if (sumCellsWidth(cells) <= width) return cells;

	const kept = fitCells(cells, width - 1);
	// 省略号沿用被截掉那段文字的样式：一行整体低调时，结尾不该突然亮起来
	const style = kept.length > 0 ? kept[kept.length - 1].style : cells[0].style;
	return [...kept, { text: ELLIPSIS, width: 1, style }];
}

export function truncateLine(line: Line, width: number): Line {
	return lineOfCells(truncateCells(cellsOf(line), width));
}
