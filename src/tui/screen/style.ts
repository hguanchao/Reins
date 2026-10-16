import type { ColorName, Line, Style } from "../text/line.ts";

/**
 * 样式到控制序列的转换。
 *
 * 样式在文本层是数据，到这里才变成字节。分层的好处是所有排版算法都不必去认转义序列，
 * 而「关掉颜色」这件事只需要在这里做一次：使用者禁用了颜色，后面所有输出自然都不带颜色。
 */

export const RESET = "\x1b[0m";

const COLOR_CODES: Readonly<Record<ColorName, number>> = {
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	gray: 90,
};

/** 该样式对应的转义序列；没有可输出的样式时返回空串。 */
export function styleSequence(style: Style | undefined, colors: boolean): string {
	if (style === undefined || !colors) return "";

	const codes: number[] = [];
	if (style.bold === true) codes.push(1);
	if (style.dim === true) codes.push(2);
	if (style.italic === true) codes.push(3);
	if (style.underline === true) codes.push(4);
	if (style.reverse === true) codes.push(7);
	if (style.color !== undefined) codes.push(COLOR_CODES[style.color]);

	return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

/**
 * 是否输出颜色。
 *
 * 认的是通行的那两个约定：NO_COLOR 一旦有值就表示不要颜色，TERM=dumb 表示终端不支持任何
 * 控制序列。除此之外一律输出——现代终端都支持 ANSI 颜色，为此做能力探测反而容易猜错。
 */
export function colorSupport(env: Readonly<Record<string, string | undefined>>): boolean {
	const noColor = env["NO_COLOR"];
	if (noColor !== undefined && noColor !== "") return false;
	if (env["TERM"] === "dumb") return false;
	return true;
}

/** 把一行写成可直接送到终端的字节；每个带样式的片段结束后复位，样式不会漏到下一段。 */
export function serializeLine(line: Line, colors: boolean): string {
	let text = "";
	for (const span of line) {
		const sequence = styleSequence(span.style, colors);
		text += sequence === "" ? span.text : `${sequence}${span.text}${RESET}`;
	}
	return text;
}
