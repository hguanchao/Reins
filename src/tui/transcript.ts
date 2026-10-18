import { eastAsianWidth } from "get-east-asian-width";

/**
 * 对话流渲染。
 *
 * 用户提示按 grok-build 的方式作为吸顶区块：发送后落在视口顶部，回复在它下方增长；
 * 回复向上滚出视口时，提示块固定在顶部，提示下方保留一行空隙。旧提示仍留在滚动流里，
 * 往上滚就能看到，不折叠、不汇总。
 */

export interface TranscriptTurn {
	readonly prompt: string;
	readonly response: readonly string[];
}

/** 用户提示背景 #242424。 */
const PROMPT_BG = "\x1b[48;2;36;36;36m";
/** 提示前缀 #c8c8c8。 */
const PROMPT_PREFIX_COLOR = "\x1b[38;2;200;200;200m";
/** 提示正文 #e1e1e1。 */
const PROMPT_TEXT_COLOR = "\x1b[38;2;225;225;225m";
/** 滚动条 #242424。 */
const SCROLLBAR_COLOR = "\x1b[38;2;36;36;36m";
const SCROLLBAR_TRACK = "│";
const SCROLLBAR_THUMB = "█";
const RESET = "\x1b[0m";

const PROMPT_PREFIX = "› ";
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
): TranscriptMetrics {
	const built = build(contentWidth(terminalWidth), turns);
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
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];
	if (turns.length === 0) return Array.from({ length: rows }, () => "");

	const width = contentWidth(terminalWidth);
	const built = build(width, turns);
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
		const contentTop =
			top >= prompt.responseStart ? top + header.length : prompt.responseStart;
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

function build(width: number, turns: readonly TranscriptTurn[]): BuiltTranscript {
	const lines: string[] = [];
	const prompts: PromptRange[] = [];

	for (const turn of turns) {
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
	}

	return { lines, prompts };
}

/** 提示块上下各留一行背景，正文最多三行，放不下时在第三行末尾补省略号。 */
function promptBlock(prompt: string, width: number): readonly string[] {
	const prefixWidth = Math.min(PROMPT_PREFIX.length, width);
	const lines = wrapPrompt(prompt, Math.max(0, width - prefixWidth), PROMPT_MAX_LINES);
	const content = lines.map((line, index) => {
		const prefix = (index === 0 ? PROMPT_PREFIX : RESPONSE_INDENT).slice(0, width);
		const usedPrefixWidth = displayWidth(prefix);
		const text = truncateToWidth(line, Math.max(0, width - usedPrefixWidth));
		const padding = " ".repeat(Math.max(0, width - usedPrefixWidth - displayWidth(text)));
		return `${PROMPT_BG}${PROMPT_PREFIX_COLOR}${prefix}${PROMPT_TEXT_COLOR}${text}${padding}${RESET}`;
	});
	const empty = `${PROMPT_BG}${" ".repeat(width)}${RESET}`;
	return [empty, ...content, empty];
}

function responseLines(text: string, width: number): readonly string[] {
	const prefixWidth = Math.min(RESPONSE_INDENT.length, width);
	const lines = wrapText(text, Math.max(0, width - prefixWidth));

	return lines.map((line) => {
		const content = truncateToWidth(RESPONSE_INDENT + line, width);
		const padding = " ".repeat(Math.max(0, width - displayWidth(content)));
		return content + padding;
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
	const thumbHeight = Math.min(height, Math.max(1, Math.floor((height * height) / Math.max(1, total))));
	const maxThumbTop = Math.max(0, height - thumbHeight);
	const maxScroll = Math.max(1, total - height);
	const thumbTop = Math.round((top / maxScroll) * maxThumbTop);

	return Array.from({ length: height }, (_, row) => {
		const char = row >= thumbTop && row < thumbTop + thumbHeight ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
		return `${SCROLLBAR_COLOR}${char}${RESET}`;
	});
}
