import { eastAsianWidth } from "get-east-asian-width";

/**
 * 主区域内容。
 *
 * 启动画面只负责品牌名与版本号；对话开始后改由 renderMessages 输出用户消息块。
 */

const BRAND = "Reins";
const MESSAGE_LINES = 3;
const USER_PREFIX = "› ";
const CONTINUATION_PREFIX = "  ";
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
 * 每条消息固定三行：第一行带 › 前缀，正文按显示宽度换行，超过三行时在末行用 … 收尾。
 * 三行都铺满终端宽度并加灰色背景，因此块的高度是可预期的；消息从底部往上排列，超出可视
 * 区域时保留最新的那几条。
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
	const contentWidth = Math.max(0, width - USER_PREFIX.length);
	const lines = wrapMessage(message, contentWidth, MESSAGE_LINES);
	return lines.map((line, index) =>
		grayLine(`${index === 0 ? USER_PREFIX : CONTINUATION_PREFIX}${line}`, width),
	);
}

/** 按显示宽度切行；最多 maxLines 行，放不下时在最后一行补省略号。 */
function wrapMessage(message: string, limit: number, maxLines: number): readonly string[] {
	const chars = Array.from(message);
	const lines: string[] = [];
	let index = 0;

	while (lines.length < maxLines) {
		const last = lines.length === maxLines - 1;
		let line = "";
		let used = 0;

		while (index < chars.length) {
			const char = chars[index];
			const charWidth = characterWidth(char);
			if (used + charWidth > limit) break;
			line += char;
			used += charWidth;
			index += 1;
		}

		if (index < chars.length && last) {
			const ellipsis = "…";
			const ellipsisWidth = characterWidth(ellipsis);
			if (limit >= ellipsisWidth) {
				const kept = Array.from(line);
				let keptWidth = used;
				while (kept.length > 0 && keptWidth + ellipsisWidth > limit) {
					keptWidth -= characterWidth(kept.pop() ?? "");
				}
				line = kept.join("") + ellipsis;
			}
		}

		lines.push(line);

		if (index >= chars.length) break;
		if (line.length === 0) {
			// 单个字符比整行还宽，吃掉它，避免原地打转
			index += 1;
		}
	}

	while (lines.length < maxLines) lines.push("");
	return lines;
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

function characterWidth(char: string): number {
	return eastAsianWidth(char.codePointAt(0) ?? 0);
}

function center(text: string, width: number): string {
	const padding = Math.max(0, Math.floor((width - text.length) / 2));
	return " ".repeat(padding) + text;
}
