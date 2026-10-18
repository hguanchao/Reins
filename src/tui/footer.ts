import { eastAsianWidth } from "get-east-asian-width";

/**
 * 页脚输入框。
 *
 * 三行：上边框、输入行、下边框；边框铺满整个终端宽度。光标交给终端自己画，这一层只算出
 * 输入行实际显示哪一段，以及光标应落在第几列。第一次按 Ctrl+C 时，提示嵌在下边框里，不
 * 挤占输入。
 */

export interface InputView {
	/** 输入行实际显示的文字；超出宽度时只保留尾部 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
}

const EXIT_HINT = "Press Ctrl+C again to exit";

/**
 * 输入行的可见部分与光标列。
 *
 * 最后一列留给终端光标，所以正文最多用 width-1 列；这样光标始终有地方停，输入再长也不会
 * 把整行挤出去。
 */
export function inputView(input: string, width: number): InputView {
	const tail = tailWithin(input, Math.max(0, width - 1));
	return {
		text: tail.text,
		column: Math.min(Math.max(1, width), tail.width + 1),
	};
}

export function renderFooter(width: number, input: string, exitArmed: boolean): readonly string[] {
	const columns = Math.max(0, width);
	return [
		horizontal(columns),
		inputView(input, columns).text,
		exitArmed ? hintBorder(columns) : horizontal(columns),
	];
}

/** 从尾部往前留出不超过 limit 列，避免宽字符被切成半个。 */
function tailWithin(text: string, limit: number): { text: string; width: number } {
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

	return { text: chars.slice(start).join(""), width: used };
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
