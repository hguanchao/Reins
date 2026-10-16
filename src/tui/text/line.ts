import { displayWidth, graphemeWidth, segmentGraphemes } from "./width.ts";

/**
 * 带样式的文本行。
 *
 * 界面里的每一行都表示成「若干同样式的片段」，样式是数据结构而不是拼好的转义序列。这样做
 * 有两个直接好处：算宽度时不必再跳过转义序列（跳过时漏掉一个字符就会让整行错位），测试也
 * 能直接比较数据结构，而不是去比一串控制字符。
 *
 * 换行、截断、光标定位都需要逐字处理，所以这里还提供「字素簇」这一层的投影：把片段摊成
 * 一个个格子，每个格子已经在建好时算过宽度。摊平之后，凡是按列工作的算法都只跟格子打交道，
 * 不必反复回到字符串上。
 */

export type ColorName =
	| "black"
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "cyan"
	| "white"
	| "gray";

export interface Style {
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	/** 前景与背景互换。光标就是靠它显示的：反显的那一格就是光标。 */
	readonly reverse?: boolean;
	readonly color?: ColorName;
}

export interface Span {
	readonly text: string;
	readonly style?: Style;
}

/** 一行就是一串片段；空行用空数组表示。 */
export type Line = readonly Span[];

/** 一个字素簇，宽度在建好时算定。 */
export interface Cell {
	readonly text: string;
	readonly width: number;
	readonly style?: Style;
}

/** 换行后的结果：格子序列加它实际占的列数。 */
export interface CellLine {
	readonly cells: readonly Cell[];
	readonly width: number;
	/**
	 * 这一行的内容在输入格子里的起点。
	 *
	 * 光标定位要用它：换行会重排格子，但任何格子都不会被丢掉，因此「输入里的第 i 个格子」
	 * 与「输出行里的某个格子」是一一对应的，只要知道这一行从哪开始。
	 */
	readonly sourceStart: number;
}

export function plain(text: string): Line {
	return text.length === 0 ? [] : [{ text }];
}

export function styled(text: string, style: Style): Line {
	return text.length === 0 ? [] : [{ text, style }];
}

/** 拼接若干行片段。空片段在这里就被丢掉，后面各层的宽度计算不必再处理零长度片段。 */
export function concat(...parts: readonly Line[]): Line {
	const spans: Span[] = [];
	for (const part of parts) {
		for (const span of part) {
			if (span.text.length > 0) spans.push(span);
		}
	}
	return spans;
}

export function lineWidth(line: Line): number {
	let total = 0;
	for (const span of line) total += displayWidth(span.text);
	return total;
}

/** 取出不含样式的纯文本，用于比较与拼接。 */
export function lineText(line: Line): string {
	return line.map((span) => span.text).join("");
}

/**
 * 叠加两层样式。
 *
 * 布尔项取并集：外层说「整段低调」时，内层已经标粗的片段不该丢掉粗体。颜色内层优先，
 * 因为内层的颜色更具体。
 *
 * 结果只保留确实生效的项：样式在界面上要反复比较（相邻片段同样式就合并），字段里塞满
 * 一堆 false 会让「两个样式是不是同一个」变得难以判断。
 */
export function mergeStyles(base: Style | undefined, extra: Style | undefined): Style | undefined {
	if (base === undefined) return extra;
	if (extra === undefined) return base;

	const merged: {
		bold?: boolean;
		dim?: boolean;
		italic?: boolean;
		underline?: boolean;
		reverse?: boolean;
		color?: ColorName;
	} = {};
	if (base.bold === true || extra.bold === true) merged.bold = true;
	if (base.dim === true || extra.dim === true) merged.dim = true;
	if (base.italic === true || extra.italic === true) merged.italic = true;
	if (base.underline === true || extra.underline === true) merged.underline = true;
	if (base.reverse === true || extra.reverse === true) merged.reverse = true;
	const color = extra.color ?? base.color;
	if (color !== undefined) merged.color = color;

	return Object.keys(merged).length === 0 ? undefined : merged;
}

/** 逐片段改样式，用于给整块内容压一层外层样式。 */
export function mapLine(line: Line, transform: (style: Style | undefined) => Style | undefined): Line {
	return line.map((span) => ({ text: span.text, style: transform(span.style) }));
}

/** 把行首补空格到指定宽度。已经够宽时原样返回——截断是另一件事。 */
export function padLine(line: Line, width: number): Line {
	const missing = width - lineWidth(line);
	return missing <= 0 ? line : concat(line, plain(" ".repeat(missing)));
}

/** 按字素簇摊平片段。 */
export function cellsOf(line: Line): readonly Cell[] {
	const cells: Cell[] = [];
	for (const span of line) {
		for (const cluster of segmentGraphemes(span.text)) {
			cells.push(
				span.style === undefined
					? { text: cluster, width: graphemeWidth(cluster) }
					: { text: cluster, width: graphemeWidth(cluster), style: span.style },
			);
		}
	}
	return cells;
}

/**
 * 把格子拼回片段。
 *
 * 相邻同样式的格子合并成一个片段：不合并的话，一个段落会变成上千个片段，输出时会为每个
 * 片段写一次样式转义序列，白白撑大输出量。
 */
export function lineOfCells(cells: readonly Cell[]): Line {
	const spans: Span[] = [];
	let current: { text: string; style: Style | undefined } | undefined;

	for (const cell of cells) {
		if (current !== undefined && sameStyle(current.style, cell.style)) {
			current.text += cell.text;
			continue;
		}
		if (current !== undefined) spans.push(spanOf(current));
		current = { text: cell.text, style: cell.style };
	}
	if (current !== undefined) spans.push(spanOf(current));

	return spans;

	function spanOf(entry: { text: string; style: Style | undefined }): Span {
		return entry.style === undefined ? { text: entry.text } : { text: entry.text, style: entry.style };
	}
}

export function sumCellsWidth(cells: readonly Cell[]): number {
	let total = 0;
	for (const cell of cells) total += cell.width;
	return total;
}

function sameStyle(left: Style | undefined, right: Style | undefined): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	return (
		left.bold === right.bold &&
		left.dim === right.dim &&
		left.italic === right.italic &&
		left.underline === right.underline &&
		left.reverse === right.reverse &&
		left.color === right.color
	);
}
