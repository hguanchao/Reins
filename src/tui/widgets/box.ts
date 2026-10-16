import {
	cellsOf,
	concat,
	lineWidth,
	plain,
	styled,
	sumCellsWidth,
	type Line,
	type Style,
} from "../text/line.ts";
import { truncateCells } from "../text/truncate.ts";
import { wrapLine } from "../text/wrap.ts";

/**
 * 带边框的方块，用来框住需要使用者做判断的内容。
 *
 * 边框把「这是一次询问」与周围的流水账分开，也把键盘的作用范围框出来：此时按键属于这个
 * 方块，不属于输入框。标题挤不下时截断标题，边框本身不变形——破掉的边框比没有边框更难读。
 *
 * 内容行由方块自己折行：调用方只管给出整段文字，不必先算好内部可用宽度。
 */

export interface BoxOptions {
	/** 可用列数，含边框 */
	readonly width: number;
	readonly title?: string;
	readonly lines: readonly Line[];
	/** 边框与标题的样式 */
	readonly border?: Style;
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const VERTICAL = "│";
const HORIZONTAL = "─";

/** 边框本身的最小宽度：左右各一个字符加内容的一列。比这更窄就画不成方框了。 */
const MIN_WIDTH = 6;

export function renderBox(options: BoxOptions): readonly Line[] {
	const width = Math.max(MIN_WIDTH, options.width);
	const border = options.border ?? { dim: true };
	const inner = width - 2;

	const lines: Line[] = [borderRow(TOP_LEFT, TOP_RIGHT, options.title ?? "")];
	for (const line of options.lines) {
		for (const wrapped of wrapLine(line, { width: inner - 2 })) lines.push(contentRow(wrapped));
	}
	lines.push(borderRow(BOTTOM_LEFT, BOTTOM_RIGHT, ""));
	return lines;

	function borderRow(left: string, right: string, title: string): Line {
		// 标题被截断时补省略号：使用者要知道标题没显示全
		const label = title === "" ? [] : truncateCells(cellsOf(plain(title)), Math.max(0, inner - 2));
		const used = label.length === 0 ? 0 : sumCellsWidth(label) + 2;
		const text = label.map((cell) => cell.text).join("");
		return concat(
			styled(left, border),
			plain(label.length === 0 ? "" : ` ${text} `),
			styled(HORIZONTAL.repeat(Math.max(0, inner - used)), border),
			styled(right, border),
		);
	}

	function contentRow(line: Line): Line {
		const available = inner - 2;
		const padding = " ".repeat(Math.max(0, available - lineWidth(line)));
		return concat(
			styled(VERTICAL, border),
			plain(" "),
			line,
			plain(padding),
			plain(" "),
			styled(VERTICAL, border),
		);
	}
}
