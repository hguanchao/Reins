import { eastAsianWidth } from "get-east-asian-width";

/**
 * 页脚输入框。
 *
 * 三行：上边框、输入行、下边框；边框铺满整个终端宽度。光标交给终端自己画，这一层只算出
 * 输入行实际显示哪一段，以及光标应落在第几列。边框与提示符随焦点切换颜色，正文保持默认
 * 颜色，避免整行一起变色影响阅读。
 */

export interface InputView {
	/** 可见的提示符；窗口太窄时会被截断 */
	readonly prefix: string;
	/** 输入行实际显示的文字；超出宽度时只保留尾部 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
}

/** 左侧留一列缩进，再放提示符，提示符与正文之间留一列。 */
const INPUT_PREFIX = " › ";
/** 获得焦点时边框与提示符的颜色 #cccccc。 */
const FOCUS_COLOR = "\x1b[38;2;204;204;204m";
/** 失去焦点时边框与提示符的颜色 #2e2e2e。 */
const BLUR_COLOR = "\x1b[38;2;46;46;46m";
const RESET = "\x1b[0m";

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
		prefix,
		text: tail.text,
		column: Math.min(Math.max(1, width), prefixWidth + tail.width + 1),
	};
}

export function renderFooter(width: number, input: string, focused: boolean): readonly string[] {
	const columns = Math.max(0, width);
	const view = inputView(input, columns);
	return [
		colored(horizontal(columns), focused),
		colored(view.prefix, focused) + view.text,
		colored(horizontal(columns), focused),
	];
}

function colored(text: string, focused: boolean): string {
	return `${focused ? FOCUS_COLOR : BLUR_COLOR}${text}${RESET}`;
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
