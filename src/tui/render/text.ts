import { eastAsianWidth } from "get-east-asian-width";
import { stripVTControlCharacters } from "node:util";

import { THEME } from "./theme.ts";

/**
 * 终端文本的宽度计算与基础排版。
 *
 * 一列宽度的判断必须与终端一致：中文、emoji 占两列，组合字符不占列。渲染层按字符折行、
 * 截断和补齐都只走这里，避免同一套规则散落在各处。
 */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** 组合标记、格式字符与变体选择符本身不占列。 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\uFE0E\uFE0F\p{Emoji_Modifier}]$/u;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * 把文本切成字素簇。
 *
 * 终端把「一个用户看到的字符」当成一列单位：组合符、ZWJ 序列、肤色修饰符、
 * 区域指示符都要整体计算，按码位遍历会把它们拆成多个字。
 */
export function graphemes(text: string): string[] {
	return Array.from(SEGMENTER.segment(text), (item) => item.segment);
}

/**
 * 一个字素簇占多少列。
 *
 * 单码位仍按 East Asian Width 判断；组合标记计 0；变体选择符要求 emoji 呈现、
 * ZWJ 连接序列与区域指示符（国旗）整体按两列算。
 */
export function characterWidth(grapheme: string): number {
	if (grapheme.length === 0) return 0;
	if (ZERO_WIDTH.test(grapheme)) return 0;
	if (grapheme.includes("\uFE0F")) return 2;
	if (grapheme.includes("\u200D") || /\p{Regional_Indicator}/u.test(grapheme)) return 2;
	if ([...grapheme].length === 1) return eastAsianWidth(grapheme.codePointAt(0) ?? 0);
	// 基字符 + 组合符：宽度取基字符
	const base = [...grapheme].find((char) => !ZERO_WIDTH.test(char));
	return base === undefined ? 0 : eastAsianWidth(base.codePointAt(0) ?? 0);
}

export function displayWidth(text: string): number {
	// 纯 ASCII 是绝大多数行的情况，省掉分段开销
	if (ASCII_ONLY.test(text)) return text.length;
	let width = 0;
	for (const grapheme of graphemes(text)) width += characterWidth(grapheme);
	return width;
}

export function truncateToWidth(text: string, width: number): string {
	const chars = graphemes(text);
	let used = 0;
	let end = 0;

	while (end < chars.length) {
		const charWidth = characterWidth(chars[end] ?? "");
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	return chars.slice(0, end).join("");
}

/**
 * 按显示宽度折行；超长单词也按字符切开，保证每一行都不超过上限。
 *
 * 换行符是硬断行：调用方给的常常是模型输出、文件内容或错误正文，里面本来就有换行。
 * 把它当成宽度 1 的普通字符会让整段挤进一行，终端却按 LF 下移，帧就错位了。
 */
export function wrapText(text: string, limit: number): string[] {
	if (limit <= 0) return [""];

	const lines: string[] = [];
	for (const paragraph of sanitizeForDisplay(text).split("\n")) {
		const chars = graphemes(paragraph);
		let line = "";
		let used = 0;

		for (const char of chars) {
			const charWidth = characterWidth(char);
			if (used + charWidth > limit && line.length > 0) {
				lines.push(line);
				line = "";
				used = 0;
			}
			line += char;
			used += charWidth;
		}

		lines.push(line);
	}
	return lines;
}

/**
 * 按显示宽度折行，优先在空格处断开。
 *
 * 说明性文字用这一版：英文单词被切成两半读起来很别扭。单个词本身超过一行、以及中文这类
 * 没有空格的文本，退回逐字符折行，保证宽字符不会被切成半个。
 */
export function wrapWords(text: string, limit: number): string[] {
	if (limit <= 0) return [""];

	const lines: string[] = [];
	// 换行符是硬断行：说明文字里常带换行（错误正文、frontmatter 块标量），必须按行拆开。
	for (const paragraph of sanitizeForDisplay(text).split("\n")) {
		wrapParagraph(paragraph, limit, lines);
	}
	return lines;
}

/** 单段（不含换行）的按词折行，结果追加进 lines。 */
function wrapParagraph(text: string, limit: number, lines: string[]): void {
	let line = "";
	let used = 0;
	const push = (): void => {
		lines.push(line);
		line = "";
		used = 0;
	};

	for (const word of text.split(" ")) {
		const wordWidth = displayWidth(word);
		const gap = line.length === 0 ? 0 : 1;
		if (used + gap + wordWidth <= limit) {
			line = line.length === 0 ? word : `${line} ${word}`;
			used += gap + wordWidth;
			continue;
		}

		if (line.length > 0) push();
		if (wordWidth <= limit) {
			line = word;
			used = wordWidth;
			continue;
		}

		for (const char of graphemes(word)) {
			const charWidth = characterWidth(char);
			if (used + charWidth > limit && line.length > 0) push();
			line += char;
			used += charWidth;
		}
	}

	lines.push(line);
}

/** 截到指定宽度；放不下时末尾补省略号，保证结果不超过宽度。 */
export function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;

	const chars = graphemes(text);
	let used = 0;
	let end = 0;
	while (end < chars.length) {
		const charWidth = characterWidth(chars[end] ?? "");
		if (used + charWidth > width - 1) break;
		used += charWidth;
		end += 1;
	}
	return `${chars.slice(0, end).join("")}…`;
}

/** 整行染一个颜色的排版行：截到宽度并用空格补齐，底色与高亮都不会只在半行上。 */
export function coloredLine(text: string, width: number, color: string): string {
	const visible = truncateToWidth(text, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
	return `${color}${visible}${THEME.reset}${padding}`;
}

/**
 * 折行并悬挂缩进：首行带 prefix，续行缩进到 prefix 之后，整段同一个颜色。
 *
 * 对话流里「一条逻辑行占多个屏幕行」的块（说明、通知、任务条目）都用它，续行才不会
 * 折回行首盖住标记列。传入的文本来自模型、文件或插件，先清掉转义序列再排版。
 */
export function wrappedLines(
	text: string,
	prefix: string,
	width: number,
	color: string,
): readonly string[] {
	const prefixWidth = displayWidth(prefix);
	const lines = wrapText(sanitizeForDisplay(text), Math.max(0, width - prefixWidth));
	const continuation = " ".repeat(prefixWidth);

	return lines.map((line, index) =>
		coloredLine(`${index === 0 ? prefix : continuation}${line}`, width, color),
	);
}

/**
 * 清掉不可打印的终端控制序列。
 *
 * 界面上显示的文本多半不是使用者自己敲的——模型输出、文件内容、命令输出、插件消息都可能
 * 带 ESC 序列。它们能清屏、移动光标、改写剪贴板，让「看到的」与「实际的」不一致。
 */
export function sanitizeForDisplay(text: string): string {
	return stripVTControlCharacters(text)
		// CR 会让终端从行首重写整行，必须归一：CRLF 是换行，单独的 CR 当成空格
		.replace(/\r\n?/g, (match) => (match.length === 2 ? "\n" : " "))
		// 制表符的宽度取决于当前列，排版层拿不到真实列号；统一展开成空格，
		// 否则宽度计算会把一个会跳格的控制字符当成零列，整行对齐全错
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
