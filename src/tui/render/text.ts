import { eastAsianWidth } from "get-east-asian-width";

import { THEME } from "./theme.ts";

/**
 * 终端文本的宽度计算与基础排版。
 *
 * 一列宽度的判断必须与终端一致：中文、emoji 占两列，组合字符不占列。渲染层按字符折行、
 * 截断和补齐都只走这里，避免同一套规则散落在各处。
 */

export function characterWidth(char: string): number {
	return eastAsianWidth(char.codePointAt(0) ?? 0);
}

export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += characterWidth(char);
	return width;
}

export function truncateToWidth(text: string, width: number): string {
	const chars = Array.from(text);
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

/** 按显示宽度折行；超长单词也按字符切开，保证每一行都不超过上限。 */
export function wrapText(text: string, limit: number): string[] {
	if (limit <= 0) return [""];

	const chars = Array.from(text);
	const lines: string[] = [];
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

		for (const char of word) {
			const charWidth = characterWidth(char);
			if (used + charWidth > limit && line.length > 0) push();
			line += char;
			used += charWidth;
		}
	}

	lines.push(line);
	return lines;
}

/** 截到指定宽度；放不下时末尾补省略号，保证结果不超过宽度。 */
export function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;

	const chars = Array.from(text);
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
 * 折回行首盖住标记列。
 */
export function wrappedLines(
	text: string,
	prefix: string,
	width: number,
	color: string,
): readonly string[] {
	const prefixWidth = displayWidth(prefix);
	const lines = wrapText(text, Math.max(0, width - prefixWidth));
	const continuation = " ".repeat(prefixWidth);

	return lines.map((line, index) =>
		coloredLine(`${index === 0 ? prefix : continuation}${line}`, width, color),
	);
}
