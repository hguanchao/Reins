import { lineText, overlayChar, type Line } from "../../tui/text/line.ts";
import { OUTER_PAD } from "./layout.ts";
import { BRIGHT, EDGE } from "./theme.ts";

/**
 * 主区的整块装饰。
 *
 * 这些函数只关心「已经摊平的行 + 一个块的范围」：选中框、右上角复制按钮都在最后覆盖到
 * 行上，不改变会话内容本身，也不参与滚动计算。
 */

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
