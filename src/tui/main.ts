import { eastAsianWidth } from "get-east-asian-width";

/**
 * 主区域内容。
 *
 * 启动画面只负责品牌名与版本号；对话开始后改由 renderMessages 输出用户消息块。
 */

const BRAND = "Reins";
const USER_PREFIX = "› ";
/** 消息正文左侧留一列，和输入行的缩进对齐。 */
const MESSAGE_INDENT = " ";
/** 用户消息块背景色 #2e2e2e。 */
const GRAY_BACKGROUND = "\x1b[48;2;46;46;46m";
/** 滚动条轨道与滑块，颜色同为 #2e2e2e。 */
const SCROLLBAR_COLOR = "\x1b[38;2;46;46;46m";
const SCROLLBAR_TRACK = "│";
const SCROLLBAR_THUMB = "█";
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
 * 用户消息区。
 *
 * 每次只展开一条消息：最新消息固定在最上面，旧消息收起，通过滚动切换。每条消息块固定
 * 三行，正文在第二行左对齐，背景 #2e2e2e，正文超出宽度时用 … 收尾。有旧消息时右侧显示
 * 滚动条。scrollIndex 表示从最新一条往上翻了几条，0 就是最新。
 */
export function renderMessages(
	width: number,
	height: number,
	messages: readonly string[],
	scrollIndex = 0,
): readonly string[] {
	const columns = Math.max(0, width);
	const rows = Math.max(0, height);
	if (messages.length === 0 || rows === 0) return Array.from({ length: rows }, () => "");

	const maxIndex = messages.length - 1;
	const index = Math.min(Math.max(0, scrollIndex), maxIndex);
	const message = messages[maxIndex - index];
	const hasHistory = messages.length > 1;
	const contentWidth = Math.max(0, columns - (hasHistory ? 2 : 0));
	const block = messageBlock(message, contentWidth);

	if (!hasHistory) {
		return [...block, ...Array.from({ length: Math.max(0, rows - block.length) }, () => "")].slice(0, rows);
	}

	const scrollbar = renderHistoryScrollbar(rows, messages.length, index);
	const gap = " ".repeat(Math.max(0, columns - contentWidth - 1));
	const blank = " ".repeat(contentWidth);
	return Array.from({ length: rows }, (_, row) => {
		const line = row < block.length ? block[row] : "";
		const content = line === "" ? blank : line;
		return content + gap + scrollbar[row];
	});
}

/** 滑块高度按“当前只展开一条”计算，位置随翻到第几条消息移动。 */
function renderHistoryScrollbar(height: number, total: number, index: number): readonly string[] {
	const thumbHeight = Math.max(1, Math.floor(height / total));
	const maxThumbTop = height - thumbHeight;
	const maxIndex = total - 1;
	const thumbTop = maxIndex === 0 ? 0 : Math.round((index / maxIndex) * maxThumbTop);

	return Array.from({ length: height }, (_, row) => {
		const char = row >= thumbTop && row < thumbTop + thumbHeight ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
		return `${SCROLLBAR_COLOR}${char}${RESET}`;
	});
}

function messageBlock(message: string, width: number): readonly string[] {
	const content = truncateWithEllipsis(`${MESSAGE_INDENT}${USER_PREFIX}${message}`, width);
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
