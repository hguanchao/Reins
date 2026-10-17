import { cellsOf, lineOfCells, mergeStyles, type Line, type Style } from "../../tui/index.ts";

/**
 * 主区文本选区。
 *
 * 选区端点记的是内容行号与该行第几个字素簇，不带任何渲染状态；这样滚动、折叠和重新排版
 * 之后仍能把同一段文字取出来。读取时去掉行尾的铺底空白与对齐空格。
 */

export interface SelectionPoint {
	readonly line: number;
	readonly cell: number;
}

export interface SelectionRegion {
	readonly anchor: SelectionPoint;
	readonly focus: SelectionPoint;
}

/** 选区里的纯文本：按行拼接，去掉每行末尾的铺底空白与对齐空格。 */
export function selectionText(history: readonly Line[], selection: SelectionRegion): string {
	const { start, end } = ordered(selection);
	const lines: string[] = [];
	for (let index = start.line; index <= end.line; index += 1) {
		const cells = cellsOf(history[index] ?? []);
		if (cells.length === 0) {
			lines.push("");
			continue;
		}
		const from = index === start.line ? Math.min(start.cell, cells.length - 1) : 0;
		const to = index === end.line ? Math.min(end.cell, cells.length - 1) : cells.length - 1;
		lines.push(
			cells
				.slice(from, to + 1)
				.map((cell) => cell.text)
				.join("")
				.replace(/[ \t]+$/u, ""),
		);
	}
	return lines.join("\n");
}

/** 这一行落在选区里时，返回要反显的字素簇范围（含两端）。 */
export function selectionRange(
	line: number,
	selection: SelectionRegion,
	history: readonly Line[],
): { readonly from: number; readonly to: number } | undefined {
	const { start, end } = ordered(selection);
	if (line < start.line || line > end.line) return undefined;

	const count = cellsOf(history[line] ?? []).length;
	if (count === 0) return undefined;
	const from = line === start.line ? Math.min(start.cell, count - 1) : 0;
	const to = line === end.line ? Math.min(end.cell, count - 1) : count - 1;
	return from > to ? undefined : { from, to };
}

/** 给一段字素簇叠上选区样式；其余格子保持原样。 */
export function highlightSelection(
	line: Line,
	from: number,
	to: number,
	style: Style,
): Line {
	return lineOfCells(
		cellsOf(line).map((cell, index) =>
			index >= from && index <= to ? { ...cell, style: mergeStyles(cell.style, style) } : cell,
		),
	);
}

function ordered(selection: SelectionRegion): {
	readonly start: SelectionPoint;
	readonly end: SelectionPoint;
} {
	const { anchor, focus } = selection;
	const reversed =
		anchor.line > focus.line || (anchor.line === focus.line && anchor.cell > focus.cell);
	return reversed ? { start: focus, end: anchor } : { start: anchor, end: focus };
}
