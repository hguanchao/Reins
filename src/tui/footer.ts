import { eastAsianWidth } from "get-east-asian-width";

/**
 * 页脚输入框。
 *
 * 三行：上边框、输入行、下边框；边框铺满整个终端宽度。光标交给终端自己画，这一层只算出
 * 输入行实际显示哪一段，以及光标应落在第几列。
 */

export interface InputView {
	/** 输入行实际显示的内容（含提示符）；正文超出宽度时只保留尾部 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
}

/** 左侧留一列缩进，再放提示符，提示符与正文之间留一列。 */
const INPUT_PREFIX = " › ";

/**
 * 输入行的可见部分与光标列。
 *
 * 最后一列留给终端光标，所以提示符加正文最多用 width-1 列；这样光标始终有地方停，输入
 * 再长也不会把整行挤出去。
 */
export function inputView(input: string, width: number): InputView {
	const available = Math.max(0, width - 1);
	const prefix = INPUT_PREFIX.slice(0, available);
	const prefixWidth = displayWidth(prefix);
	const tail = tailWithin(input, Math.max(0, available - prefixWidth));
	return {
		text: prefix + tail.text,
		column: Math.min(Math.max(1, width), prefixWidth + tail.width + 1),
	};
}

export function renderFooter(width: number, input: string): readonly string[] {
	const columns = Math.max(0, width);
	return [horizontal(columns), inputView(input, columns).text, horizontal(columns)];
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

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += eastAsianWidth(char.codePointAt(0) ?? 0);
	return width;
}

function horizontal(width: number): string {
	return "─".repeat(width);
}
