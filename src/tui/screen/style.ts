import type { Color, ColorName, Line, Style } from "../text/line.ts";
import { sameStyle } from "../text/line.ts";

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

/**
 * 颜色对应的 SGR 参数。
 *
 * 十六色直接用码表；真彩色按 `38;2;r;g;b`（背景是 `48;2;…`）写，也就是 24 位色那套扩展写法。
 * 主题里的颜色是定死的，折算成十六色反而会走样。
 */
function colorCodes(color: Color, base: number): number[] {
	// 十六色：前景是 30–37 与 90，背景就是同一组数加十
	if (typeof color === "string") return [COLOR_CODES[color] + (base - 30)];
	return [base + 8, 2, color[0], color[1], color[2]];
}

/** 该样式对应的转义序列；没有可输出的样式时返回空串。 */
export function styleSequence(style: Style | undefined, colors: boolean): string {
	if (style === undefined || !colors) return "";

	const codes: number[] = [];
	if (style.bold === true) codes.push(1);
	if (style.dim === true) codes.push(2);
	if (style.italic === true) codes.push(3);
	if (style.underline === true) codes.push(4);
	if (style.strikethrough === true) codes.push(9);
	if (style.reverse === true) codes.push(7);
	if (style.color !== undefined) codes.push(...colorCodes(style.color, 30));
	if (style.background !== undefined) codes.push(...colorCodes(style.background, 40));

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

/**
 * 把一行写成可直接送到终端的字节。
 *
 * 样式只在变化时才发序列：相邻片段样式相同时不重复输出，行尾才复位一次。一行里动辄几十个
 * 片段，若每个片段都「开样式—复位」，重画整屏时控制序列的字节数会放大好几倍，慢终端上一
 * 帧都解析不完，画面就开始闪。
 */
export function serializeLine(line: Line, colors: boolean): string {
	let text = "";
	let current: Style | undefined;
	/** 行内是否留下了没复位的样式；只有留下过才需要在行尾补一次复位。 */
	let styled = false;
	let openLink: string | undefined;

	for (const span of line) {
		const link = colors ? safeLink(span.style?.link) : undefined;
		if (openLink !== undefined && openLink !== link) {
			text += "\x1b]8;;\x07";
			openLink = undefined;
		}
		// 链接不占 SGR，比较与输出都只看可见属性：只有链接不同的相邻片段不该重发一遍样式
		const style = colors ? visible(span.style) : undefined;
		if (!sameStyle(style, current)) {
			const sequence = styleSequence(style, colors);
			// 前一样式的属性是后一个的子集时直接叠加；否则先复位，把旧属性一并清掉
			text += styleExtends(current, style) ? sequence : `${RESET}${sequence}`;
			// 只有链接、没有可见属性的样式发不出序列，此时终端已经回到默认样式
			styled = sequence !== "";
			current = style;
		}
		if (link !== undefined && link !== openLink) {
			text += `\x1b]8;;${link}\x07`;
			openLink = link;
		}
		text += span.text;
	}

	if (openLink !== undefined) text += "\x1b]8;;\x07";
	if (styled) text += RESET;
	return text;
}

/** 去掉链接的样式：链接靠 OSC 8 表达，与样式序列无关。 */
function visible(style: Style | undefined): Style | undefined {
	return style === undefined || style.link === undefined ? style : { ...style, link: undefined };
}

/**
 * OSC 8 的链接只放行网页与邮件协议。
 *
 * 链接来自模型输出，不能把任意字符串塞进转义序列：控制字符会截断序列，`javascript:` 之类
 * 也没有在终端里打开的理由。
 */
function safeLink(link: string | undefined): string | undefined {
	if (link === undefined || link.length === 0 || link.length > 2048) return undefined;
	if (/[\x00-\x1f\x7f]/.test(link)) return undefined;
	return /^(?:https?|mailto):/i.test(link) ? link : undefined;
}

/**
 * 后一个样式的属性是否完全包含前一个：包含时可以只发增量序列。
 *
 * 反过来（比如加粗之后变普通）就必须先整段复位，否则旧属性会漏进新片段。颜色变了也要复位：
 * 我们做不到单独把前景色退回默认。
 */
function styleExtends(prev: Style | undefined, next: Style | undefined): boolean {
	if (next === undefined) return false;
	if (prev === undefined) return true;
	for (const flag of ["bold", "dim", "italic", "underline", "strikethrough", "reverse"] as const) {
		if (prev[flag] === true && next[flag] !== true) return false;
	}
	return (
		(prev.color === undefined || prev.color === next.color) &&
		(prev.background === undefined || prev.background === next.background)
	);
}
