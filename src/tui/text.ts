import { eastAsianWidth } from "get-east-asian-width";

/**
 * 终端文本的宽度计算。
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
