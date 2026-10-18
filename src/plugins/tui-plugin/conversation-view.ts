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
import { BRIGHT, DIM, EDGE, SELECT_BG, THEME } from "./theme.ts";

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

/** 选中块的边框：竖线只画在单行块上，上下角覆盖在相邻一行的格子上。 */
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
	const left = OUTER_PAD - 1;
	const right = OUTER_PAD + entryWidth;
	const result = [...lines];

	// 竖线只在单行块上围一圈；展开的块再拉两条会一路切过详情，只留四角标范围
	if (block.height === 1) {
		result[top] = overlayChar(result[top], left, "│", EDGE);
		result[top] = overlayChar(result[top], right, "│", EDGE);
	}
	// 角永远画出来：相邻一行不管有没有内容，覆盖一格就好——跳过它框就成了无头的竖线
	if (first - 1 >= 0 && first - 1 < lines.length) {
		result[first - 1] = overlayChar(result[first - 1], left, "┌", EDGE);
		result[first - 1] = overlayChar(result[first - 1], right, "┐", EDGE);
	}
	if (last + 1 < lines.length) {
		result[last + 1] = overlayChar(result[last + 1], left, "└", EDGE);
		result[last + 1] = overlayChar(result[last + 1], right, "┘", EDGE);
	}
	return result;
}

/**
 * 选中收起行的样式：整行铺高亮底色，开头的菱形换成 ▸ 护栏。
 *
 * 展开的块才有边框；收起的一行用底色和护栏标记选中，border 反而在深底上看不清。
 */
export function drawSelectionBand(
	lines: readonly Line[],
	block: BlockRange,
	windowStart: number,
	entryWidth: number,
): readonly Line[] {
	const row = block.start - windowStart;
	if (row < 0 || row >= lines.length) return [...lines];

	const line = lines[row];
	const text = lineText(line);
	const caretCol = [text.indexOf("◆"), text.indexOf("◇")].find((index) => index >= 0);
	const banded = bandLine(line, OUTER_PAD - 1, OUTER_PAD + entryWidth + 1);
	const result = [...lines];
	result[row] =
		caretCol === undefined
			? banded
			: overlayChar(banded, caretCol, "▸", { bold: true, color: BRIGHT.color, background: SELECT_BG.background });
	return result;
}

/** 选中段的高亮底色：段内的字素铺上底色，跨界宽字符用空格顶位。 */
function bandLine(line: Line, from: number, to: number): Line {
	return concat(
		sliceRange(line, 0, from),
		sliceRange(line, from, to).map((span) => ({
			text: span.text,
			style: { ...span.style, background: SELECT_BG.background },
		})),
		sliceRange(line, to, Number.POSITIVE_INFINITY),
	);
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
