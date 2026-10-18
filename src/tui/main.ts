import { eastAsianWidth } from "get-east-asian-width";

/**
 * 主区域内容。
 *
 * 启动画面只负责品牌名与版本号；对话开始后改由 renderMessages 输出用户消息块。
 */

const BRAND = "Reins";
const USER_PREFIX = "› ";
const GRAY_BACKGROUND = "\x1b[100m";
const RESET = "\x1b[0m";

/**
 * 品牌名在上、版本号在下，整体在给定区域内居中。
 *
 * 返回的行数恰好等于 height，空行也一并返回，调用方按顺序逐行写出即可。终端比文字还窄时
 * 不做截断：截断会把品牌名或版本号变成半截，宁可让它超出边界。
 */
export function renderMain(width: number, height: number, version: string): readonly string[] {
	const content = [BRAND, `v${version}`];
	const lines: string[] = Array.from({ length: Math.max(0, height) }, () => "");
	const top = Math.max(0, Math.floor((lines.length - content.length) / 2));

	for (let index = 0; index < content.length; index += 1) {
		const row = top + index;
		if (row >= lines.length) break;
		lines[row] = center(content[index], width);
	}

	return lines;
}

/**
 * 用户消息块。
 *
 * 每条消息固定三行：正文只占中间一行并水平居中，上下两行留空，三行都铺满终端宽度并加灰色
 * 背景。正文超出宽度时用 … 收尾；消息从底部往上排列，超出可视区域时保留最新的那几条。
 */
export function renderMessages(width: number, height: number, messages: readonly string[]): readonly string[] {
	const columns = Math.max(0, width);
	const rows = Math.max(0, height);
	const blockLines = messages.flatMap((message) => messageBlock(message, columns));
	const visible = blockLines.slice(Math.max(0, blockLines.length - rows));
	const padding = Math.max(0, rows - visible.length);
	return [...Array.from({ length: padding }, () => ""), ...visible];
}

function messageBlock(message: string, width: number): readonly string[] {
	const content = centerWithin(`${USER_PREFIX}${message}`, width);
	const blank = grayLine("", width);
	return [blank, grayLine(content, width), blank];
}

/** 截到 width 列；放不下时保留开头并补省略号。 */
function truncateWithEllipsis(text: string, width: number): string {
	const chars = Array.from(text);
	let used = 0;
	let end = 0;

	while (end < chars.length) {
		const charWidth = characterWidth(chars[end]);
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	if (end === chars.length) return chars.slice(0, end).join("");

	const ellipsis = "…";
	const ellipsisWidth = characterWidth(ellipsis);
	if (width < ellipsisWidth) return "";

	while (end > 0 && used + ellipsisWidth > width) {
		end -= 1;
		used -= characterWidth(chars[end]);
	}
	return chars.slice(0, end).join("") + ellipsis;
}

function centerWithin(text: string, width: number): string {
	const truncated = truncateWithEllipsis(text, width);
	const used = displayWidth(truncated);
	const leading = Math.max(0, Math.floor((width - used) / 2));
	return " ".repeat(leading) + truncated;
}

function grayLine(text: string, width: number): string {
	return `${GRAY_BACKGROUND}${fitLine(text, width)}${RESET}`;
}

/** 截到指定显示宽度，再用空格铺满，保证灰色背景横跨整行。 */
function fitLine(text: string, width: number): string {
	const chars = Array.from(text);
	let used = 0;
	let end = 0;

	while (end < chars.length) {
		const charWidth = characterWidth(chars[end]);
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	return chars.slice(0, end).join("") + " ".repeat(Math.max(0, width - used));
}

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += characterWidth(char);
	return width;
}

function characterWidth(char: string): number {
	return eastAsianWidth(char.codePointAt(0) ?? 0);
}

function center(text: string, width: number): string {
	const padding = Math.max(0, Math.floor((width - text.length) / 2));
	return " ".repeat(padding) + text;
}
