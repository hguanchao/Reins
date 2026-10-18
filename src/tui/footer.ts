import { eastAsianWidth } from "get-east-asian-width";

/**
 * 页脚输入框。
 *
 * 三行：上边框、输入行、下边框；边框铺满整个终端宽度。输入行末尾画一个反色空格当光标，
 * 因此终端自己的光标可以一直隐藏。第一次按 Ctrl+C 时，提示嵌在下边框里，不挤占输入。
 */

/** 反色空格：宽度为一列，视觉上就是输入光标。 */
const CURSOR = "\x1b[7m \x1b[0m";
const EXIT_HINT = "Press Ctrl+C again to exit";

export function renderFooter(width: number, input: string, exitArmed: boolean): readonly string[] {
	const columns = Math.max(0, width);
	return [horizontal(columns), inputLine(input, columns), exitArmed ? hintBorder(columns) : horizontal(columns)];
}

function inputLine(input: string, width: number): string {
	// 光标占一列，正文最多用到剩下的宽度；超出时保留尾部，光标始终停在输入末尾
	return tailWithin(input, Math.max(0, width - 1)) + CURSOR;
}

/** 从尾部往前留出不超过 limit 列，避免宽字符被切成半个。 */
function tailWithin(text: string, limit: number): string {
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;

	while (start > 0) {
		const char = chars[start - 1];
		const charWidth = eastAsianWidth(char.codePointAt(0) ?? 0);
		if (used + charWidth > limit) break;
		used += charWidth;
		start -= 1;
	}

	return chars.slice(start).join("");
}

function hintBorder(width: number): string {
	const text = ` ${EXIT_HINT} `;
	if (width < text.length) return horizontal(width);

	const left = Math.floor((width - text.length) / 2);
	return "─".repeat(left) + text + "─".repeat(width - text.length - left);
}

function horizontal(width: number): string {
	return "─".repeat(width);
}
