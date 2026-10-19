import { eastAsianWidth } from "get-east-asian-width";

import { THEME } from "./theme.ts";

/**
 * 对话流渲染。
 *
 * 用户提示按 grok-build 的方式作为吸顶区块：发送后落在视口顶部，回复在它下方增长；
 * 回复向上滚出视口时，提示块固定在顶部，提示下方保留一行空隙。旧提示仍留在滚动流里，
 * 往上滚就能看到，不折叠、不汇总。
 *
 * 启动警告不属于任何一轮对话，但同样走对话流：作为顶部的系统消息参与换行与滚动，不使用
 * 主区域启动画面的居中排版。
 */

export interface TranscriptTurn {
	readonly prompt: string;
	readonly response: readonly string[];
}

/** 用户提示背景，与菜单面板使用同一档浮起表面。 */
const PROMPT_BG = THEME.surface;
/** 用户提示与回复正文统一使用主文字色。 */
const MESSAGE_TEXT_COLOR = THEME.textPrimary;
/** 启动警告使用警告色，与普通正文区分开。 */
const NOTICE_COLOR = THEME.warning;
/** 滚动条颜色。 */
const SCROLLBAR_COLOR = THEME.scrollbar;
const SCROLLBAR_TRACK = " ";
const SCROLLBAR_THUMB = "█";
const RESET = THEME.reset;

/** 用户提示首行符号前留一列，正文因此比模型回复多缩进一列。 */
const PROMPT_PREFIX = " › ";
/** 提示续行与首行正文对齐。 */
const PROMPT_INDENT = "   ";
/** 模型回复的缩进。 */
const RESPONSE_INDENT = "  ";
const PROMPT_MAX_LINES = 3;
const HEADER_GAP_LINES = 1;
/** 右侧固定预留一列空隙和一列滚动条。 */
const GUTTER_WIDTH = 2;

interface PromptRange {
	/** 提示块第一行在 transcript 里的下标 */
	readonly start: number;
	/** 提示块正文行数，1 到 3 */
	readonly height: number;
	/** 提示块之后的 gap 与回复内容的起点 */
	readonly responseStart: number;
}

interface BuiltTranscript {
	readonly lines: string[];
	readonly prompts: PromptRange[];
}

export interface TranscriptMetrics {
	/** 实际写进对话流的行数 */
	readonly totalLines: number;
	/** 加上底部留白后的可滚动行数 */
	readonly scrollLines: number;
	/** 最后一条用户提示的起始行，发送后用它做 page flip */
	readonly lastPromptStart: number;
}

export function transcriptMetrics(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	notice?: string,
): TranscriptMetrics {
	const built = build(contentWidth(terminalWidth), turns, notice);
	const lastPromptStart = built.prompts.at(-1)?.start ?? 0;
	const rows = Math.max(0, height);
	return {
		totalLines: built.lines.length,
		scrollLines: Math.max(built.lines.length, lastPromptStart + rows),
		lastPromptStart,
	};
}

/**
 * 渲染可视窗口。
 *
 * scrollTop 是从 transcript 顶部滚过的行数。提示块被滚出顶部时，把它和它的 1 行 gap
 * 固定在第一行，正文从当前滚动位置继续往下画。
 */
export function renderTranscript(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	scrollTop: number,
	notice?: string,
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];
	if (turns.length === 0 && notice === undefined) return Array.from({ length: rows }, () => "");

	const width = contentWidth(terminalWidth);
	const built = build(width, turns, notice);
	const total = built.lines.length;
	const lastPromptStart = built.prompts.at(-1)?.start ?? 0;
	// 底部补白让最后一条提示可以停在视口顶部，这正是发送后的 page flip
	const scrollLines = Math.max(total, lastPromptStart + rows);
	const maxScroll = Math.max(0, scrollLines - rows);
	const top = Math.min(Math.max(0, scrollTop), maxScroll);
	const lineAt = (index: number): string => built.lines[index] ?? " ".repeat(width);

	const prompt = pinnedPrompt(built.prompts, top);
	let visible: string[];
	if (prompt !== undefined && top > prompt.start) {
		const header = built.lines
			.slice(prompt.start, prompt.start + prompt.height + HEADER_GAP_LINES)
			.slice(0, rows);
		// header 盖住视口顶部；正文从被盖住的那几行之后继续，保证底部仍是最新内容
		let contentTop =
			top >= prompt.responseStart ? top + header.length : prompt.responseStart;
		// 不要把下一条提示块切在中间：从它的顶部留白开始，避免提示块少一行
		const nextPrompt = built.prompts.find(
			(item) => item.start > prompt.start && item.start < contentTop && contentTop < item.responseStart,
		);
		if (nextPrompt !== undefined) contentTop = nextPrompt.start;

		const contentHeight = Math.max(0, rows - header.length);
		const content = Array.from({ length: contentHeight }, (_, index) => lineAt(contentTop + index));
		visible = [...header, ...content];
	} else {
		visible = Array.from({ length: rows }, (_, index) => lineAt(top + index));
	}

	const gutter = renderGutter(rows, scrollLines, top);
	return visible.map((line, index) => `${line} ${gutter[index]}`);
}

function contentWidth(terminalWidth: number): number {
	return Math.max(0, Math.max(0, terminalWidth) - GUTTER_WIDTH);
}

function build(width: number, turns: readonly TranscriptTurn[], notice: string | undefined): BuiltTranscript {
	const lines: string[] = [];
	const prompts: PromptRange[] = [];
	let previousHadResponse = false;

	if (notice !== undefined && notice.length > 0) {
		lines.push(...noticeLines(notice, width));
		// 警告和第一轮对话之间留一行间距，避免系统消息贴住提示块
		if (turns.length > 0) lines.push(" ".repeat(width));
	}

	for (const turn of turns) {
		// 上一条回复和下一条提示之间留一行默认背景，避免提示块直接贴住回复
		if (previousHadResponse) lines.push(" ".repeat(width));

		const promptLines = promptBlock(turn.prompt, width);
		const start = lines.length;
		lines.push(...promptLines);
		// 吸顶 header 下方固定一行空隙
		lines.push(" ".repeat(width));
		const responseStart = lines.length;
		for (const line of turn.response) {
			lines.push(...responseLines(line, width));
		}
		prompts.push({ start, height: promptLines.length, responseStart });
		previousHadResponse = turn.response.length > 0;
	}

	return { lines, prompts };
}

/** 提示块上下各留一行背景，正文最多三行，放不下时在第三行末尾补省略号。 */
function promptBlock(prompt: string, width: number): readonly string[] {
	const prefixWidth = Math.min(PROMPT_PREFIX.length, width);
	const lines = wrapPrompt(prompt, Math.max(0, width - prefixWidth), PROMPT_MAX_LINES);
	const content = lines.map((line, index) => {
		const prefix = (index === 0 ? PROMPT_PREFIX : PROMPT_INDENT).slice(0, width);
		const usedPrefixWidth = displayWidth(prefix);
		const text = truncateToWidth(line, Math.max(0, width - usedPrefixWidth));
		const padding = " ".repeat(Math.max(0, width - usedPrefixWidth - displayWidth(text)));
		return `${PROMPT_BG}${MESSAGE_TEXT_COLOR}${prefix}${text}${padding}${RESET}`;
	});
	const empty = `${PROMPT_BG}${" ".repeat(width)}${RESET}`;
	return [empty, ...content, empty];
}

/**
 * 启动警告。
 *
 * 与模型回复共用正文缩进和颜色，第一行多一个 `!` 标记，续行与标记后的文字对齐；宽度不够时
 * 按字符换行，交给对话流统一滚动。
 */
function noticeLines(text: string, width: number): readonly string[] {
	const firstPrefix = `${RESPONSE_INDENT}! `;
	const continuationPrefix = " ".repeat(displayWidth(firstPrefix));
	const limit = Math.max(0, width - displayWidth(firstPrefix));

	return wrapText(text, limit).map((line, index) => {
		const prefix = index === 0 ? firstPrefix : continuationPrefix;
		const visible = truncateToWidth(prefix + line, width);
		const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
		return `${NOTICE_COLOR}${visible}${padding}${RESET}`;
	});
}

function responseLines(text: string, width: number): readonly string[] {
	const prefixWidth = Math.min(RESPONSE_INDENT.length, width);
	const lines = wrapText(text, Math.max(0, width - prefixWidth));

	return lines.map((line) => {
		const content = truncateToWidth(RESPONSE_INDENT + line, width);
		const padding = " ".repeat(Math.max(0, width - displayWidth(content)));
		return `${MESSAGE_TEXT_COLOR}${content}${padding}${RESET}`;
	});
}

function wrapPrompt(text: string, limit: number, maxLines: number): readonly string[] {
	const lines = wrapText(text, limit);
	if (lines.length <= maxLines) return lines;

	const visible = lines.slice(0, maxLines);
	const ellipsis = "…";
	let last = Array.from(visible[maxLines - 1] ?? "");
	let used = displayWidth(last.join(""));

	while (last.length > 0 && used + 1 > limit) {
		const removed = last.pop();
		used -= characterWidth(removed ?? "");
	}
	visible[maxLines - 1] = last.join("") + ellipsis;
	return visible;
}

function wrapText(text: string, limit: number): string[] {
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

function truncateToWidth(text: string, width: number): string {
	const chars = Array.from(text);
	let used = 0;
	let end = 0;

	while (end < chars.length) {
		const charWidth = characterWidth(chars[end]);
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	return chars.slice(0, end).join("");
}

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += characterWidth(char);
	return width;
}

function characterWidth(char: string): number {
	return eastAsianWidth(char.codePointAt(0) ?? 0);
}

function pinnedPrompt(prompts: readonly PromptRange[], top: number): PromptRange | undefined {
	let found: PromptRange | undefined;
	for (const prompt of prompts) {
		if (prompt.start <= top) found = prompt;
		else break;
	}
	return found;
}

function renderGutter(height: number, total: number, top: number): readonly string[] {
	// 内容没有超出视口时没有可滚动的东西，整列留空，不画轨道和滑块
	if (total <= height) return Array.from({ length: height }, () => " ");

	const thumbHeight = Math.min(height, Math.max(1, Math.floor((height * height) / Math.max(1, total))));
	const maxThumbTop = Math.max(0, height - thumbHeight);
	const maxScroll = Math.max(1, total - height);
	const thumbTop = Math.round((top / maxScroll) * maxThumbTop);

	return Array.from({ length: height }, (_, row) => {
		const char = row >= thumbTop && row < thumbTop + thumbHeight ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
		return `${SCROLLBAR_COLOR}${char}${RESET}`;
	});
}
