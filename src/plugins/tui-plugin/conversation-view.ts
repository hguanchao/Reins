import {
	cellsOf,
	concat,
	lineOfCells,
	lineText,
	lineWidth,
	overlayChar,
	type Line,
	type Style,
} from "../../tui/text/line.ts";
import { GUTTER_WIDTH, OUTER_PAD } from "./layout.ts";
import { BRIGHT, DIM, EDGE, THEME } from "./theme.ts";

/**
 * 主区的整块装饰。
 *
 * 这些函数只关心「已经摊平的行 + 一个块的范围」：选中框、右上角复制按钮、悬停浮卡与时间戳
 * 展开都在最后覆盖到行上，不改变会话内容本身，也不参与滚动计算。浮卡贴着轨道左缘、盖住当
 * 行正文；时间戳展开右对齐到原时间戳的右缘。
 */

/** 卡片底色与会话色带同源；边框用亮灰，正文用亮白。 */
const CARD_BG = THEME.band;
const CARD_BORDER: Style = { color: DIM.color, background: CARD_BG };
const CARD_TEXT: Style = { color: BRIGHT.color, background: CARD_BG };

export interface BlockRange {
	readonly start: number;
	readonly height: number;
}

export interface CopyIconHit {
	/** 内容行号，不是屏幕行号。 */
	readonly line: number;
	readonly col: number;
}

/** 选中块的边框：左右竖线贴着块的可见行，上下角画在块外一行。 */
export function drawSelectionBox(
	lines: readonly Line[],
	block: BlockRange,
	windowStart: number,
	entryWidth: number,
): Line[] {
	const first = block.start - windowStart;
	const last = first + block.height - 1;
	if (last < 0 || first >= lines.length) return [...lines];

	const top = Math.max(0, first);
	const bottom = Math.min(lines.length - 1, last);
	const left = OUTER_PAD - 1;
	const right = OUTER_PAD + entryWidth;
	const result = [...lines];

	for (let row = top; row <= bottom; row += 1) {
		result[row] = overlayChar(result[row], left, "│", EDGE);
		result[row] = overlayChar(result[row], right, "│", EDGE);
	}
	if (first > 0 && lineText(result[first - 1]).trim().length === 0) {
		const row = first - 1;
		result[row] = overlayChar(result[row], left, "┌", EDGE);
		result[row] = overlayChar(result[row], right, "┐", EDGE);
	}
	if (last < lines.length - 1 && lineText(result[last + 1]).trim().length === 0) {
		const row = last + 1;
		result[row] = overlayChar(result[row], left, "└", EDGE);
		result[row] = overlayChar(result[row], right, "┘", EDGE);
	}
	return result;
}

/** 选中块右上角的复制按钮；放在块的第一条非空行上。 */
export function drawCopyIcon(
	lines: readonly Line[],
	block: BlockRange,
	windowStart: number,
	entryWidth: number,
	history: readonly Line[],
): { readonly lines: Line[]; readonly icon: CopyIconHit | undefined } {
	let line = block.start;
	while (line < block.start + block.height && lineText(history[line] ?? []).trim().length === 0) {
		line += 1;
	}
	if (line >= block.start + block.height) line = block.start;

	const row = line - windowStart;
	if (row < 0 || row >= lines.length) return { lines: [...lines], icon: undefined };

	const col = Math.max(OUTER_PAD, OUTER_PAD + entryWidth - 2);
	const result = [...lines];
	result[row] = overlayChar(result[row], col, "⧉", BRIGHT);
	return { lines: result, icon: { line, col } };
}

/**
 * 轨道悬停浮卡：贴着轨道左缘的三行卡片，盖住悬停行附近的正文。
 *
 * 卡片宽度随文本伸缩，太长截短；竖直方向以悬停行居中，出界时夹住。
 */
export function drawHoverCard(
	lines: readonly Line[],
	hoverRow: number,
	cols: number,
	text: string,
): readonly Line[] {
	const maxWidth = cols - GUTTER_WIDTH - 2;
	const clipped = clipTo(text, Math.max(0, maxWidth - 4));
	if (clipped.length === 0) return lines;
	const width = lineWidth([{ text: clipped }]) + 4;
	const right = cols - GUTTER_WIDTH - 1;
	const left = right - width + 1;
	if (left < 1) return lines;

	const middle = Math.max(1, Math.min(lines.length - 2, hoverRow));
	const padded = " ".repeat(Math.max(0, width - 4 - lineWidth([{ text: clipped }])));
	const result = [...lines];
	result[middle - 1] = splice(result[middle - 1], left, right + 1, [
		{ text: `╭${"─".repeat(width - 2)}╮`, style: CARD_BORDER },
	]);
	result[middle] = splice(result[middle], left, right + 1, [
		{ text: `│ ${clipped}${padded} │`, style: CARD_TEXT },
	]);
	result[middle + 1] = splice(result[middle + 1], left, right + 1, [
		{ text: `╰${"─".repeat(width - 2)}╯`, style: CARD_BORDER },
	]);
	return result;
}

/** 悬停时间戳时原地展开：右对齐到原时间戳的右缘，放不下就向左占。 */
export function expandTimestamp(line: Line, startCol: number, reserved: number, text: string): Line {
	let col = Math.max(0, startCol + reserved - text.length);
	let result = line;
	for (const char of text) {
		result = overlayChar(result, col, char, BRIGHT);
		col += 1;
	}
	return result;
}

/** 按显示列把行切成三段，中段整段替换；跨界宽字符换成空格顶位，列位不变。 */
function splice(line: Line, from: number, to: number, mid: Line): Line {
	return concat(sliceRange(line, 0, from), mid, sliceRange(line, to, Number.POSITIVE_INFINITY));
}

/** 取行的显示列区间 [from, to)；被区间边界切开的宽字符用空格补位。 */
function sliceRange(line: Line, from: number, to: number): Line {
	const out: { text: string; width: number; style?: Style }[] = [];
	let width = 0;
	for (const cell of cellsOf(line)) {
		const start = width;
		const end = width + cell.width;
		width = end;
		if (end <= from) continue;
		if (start >= to) break;
		if (start >= from && end <= to) out.push(cell);
		else {
			const left = Math.max(start, from);
			const right = Math.min(end, to);
			if (right > left) out.push({ text: " ".repeat(right - left), width: right - left });
		}
	}
	return lineOfCells(out);
}

/** 按显示列宽截断文本。 */
function clipTo(text: string, width: number): string {
	let result = "";
	for (const char of text) {
		if (lineWidth([{ text: result + char }]) > width) break;
		result += char;
	}
	return result;
}
