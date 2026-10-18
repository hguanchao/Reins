import {
	cellsOf,
	concat,
	lineOfCells,
	lineWidth,
	styled,
	truncateLine,
	type Cell,
	type Line,
} from "../../tui/index.ts";
import { ACCENT, THEME } from "./theme.ts";

/**
 * 输入区上方的临时提示。
 *
 * 它盖在会话区最后一行右端，不占布局、不抢快捷键条：复制结果、暂存提示这类信息出现一两秒
 * 就该消失，为此挤走一行正文或一行按键说明都不划算。
 */
export function toastLine(line: Line, width: number, text: string): Line {
	if (text.length === 0) return line;
	const toast = truncateLine(
		styled(` ${text} `, { bold: true, color: ACCENT.color, background: THEME.base }),
		width,
	);
	const keep = Math.max(0, width - lineWidth(toast));
	return concat(slice(line, keep), toast);
}

/** 保留行首的指定列数；被切开的宽字符用空格顶位。 */
function slice(line: Line, width: number): Line {
	const cells: Cell[] = [];
	let used = 0;
	for (const cell of cellsOf(line)) {
		if (used + cell.width > width) break;
		cells.push(cell);
		used += cell.width;
	}
	const result = lineOfCells(cells);
	return lineWidth(result) >= width ? result : concat(result, [{ text: " ".repeat(width - used) }]);
}
