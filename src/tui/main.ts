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
/** 每条消息块固定占三行。 */
const MESSAGE_LINES = 3;
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
 * 用户消息块。
 *
 * 每条消息固定三行：正文只占中间一行，左侧缩进一列并左对齐，上下两行留空，三行都铺满
 * 终端宽度并加灰色背景。消息块之间留一行间距；正文超出宽度时用 … 收尾。最新的消息块
 * 排在最上面，往下是更早的消息；内容超出可视区域时在右侧显示滚动条。scrollTop 是从顶部
 * 滚过的行数，0 表示停在最新消息处。
 */
export function renderMessages(
	width: number,
	height: number,
	messages: readonly string[],
	scrollTop = 0,
): readonly string[] {
	const columns = Math.max(0, width);
	const rows = Math.max(0, height);
	if (messages.length === 0) return Array.from({ length: rows }, () => "");

	const totalLines = messageLineCount(messages);
	const overflow = totalLines > rows;
	// 有滚动条时把最右一列让给滚动条，再留一列空隙，消息背景不会贴着滚动条
	const contentWidth = Math.max(0, columns - (overflow ? 2 : 0));
	const ordered = [...messages].reverse();
	const blockLines = ordered.flatMap((message, index) => {
		const block = messageBlock(message, contentWidth);
		// 第一块从顶部开始，后面的块前面留一行，避免相邻灰底粘成一整片
		return index === 0 ? block : ["", ...block];
	});

	const maxScroll = Math.max(0, totalLines - rows);
	const start = Math.min(Math.max(0, scrollTop), maxScroll);
	const visible = blockLines.slice(start, start + rows);
	const padding = Math.max(0, rows - visible.length);

	if (!overflow) return [...visible, ...Array.from({ length: padding }, () => "")];

	const scrollbar = renderScrollbar(rows, totalLines, start);
	const gap = " ".repeat(Math.max(0, columns - contentWidth - 1));
	return Array.from({ length: rows }, (_, index) => {
		const line = visible[index] ?? "";
		const content = line === "" ? " ".repeat(contentWidth) : line;
		return content + gap + scrollbar[index];
	});
}

/** 消息区的总行数：每条消息三行，块与块之间各一行间距。 */
export function messageLineCount(messages: readonly string[]): number {
	return messages.length === 0 ? 0 : messages.length * MESSAGE_LINES + (messages.length - 1);
}

/** 滑块高度按可视区比例计算，位置跟着可视窗口在内容里的起点移动。 */
function renderScrollbar(height: number, totalLines: number, start: number): readonly string[] {
	const thumbHeight = Math.max(1, Math.floor((height * height) / totalLines));
	const maxThumbTop = height - thumbHeight;
	const maxStart = Math.max(1, totalLines - height);
	const thumbTop = Math.round((start / maxStart) * maxThumbTop);

	return Array.from({ length: height }, (_, index) => {
		const char = index >= thumbTop && index < thumbTop + thumbHeight ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
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
