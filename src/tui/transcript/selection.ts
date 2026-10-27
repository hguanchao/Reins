import { characterWidth, displayWidth } from "../render/text.ts";
import { lineIndexAtRow } from "./scroll.ts";
import type { TranscriptView } from "./types.ts";

/**
 * 对话流里的文本选区。
 *
 * 端点记的是视图内行号与该行的显示列，不存渲染后的字符串：拖动、重绘、按宽度重排之后仍能
 * 取回同一段文字。行的内容可能带颜色与 OSC 8 链接，取文本时统一清掉样式，只留下屏幕上看
 * 得见的字符。
 */

export interface SelectionPoint {
	/** 视图行号，与 TranscriptView.lines 的下标一致 */
	readonly line: number;
	/** 该行内第几列，按显示宽度从 0 起算 */
	readonly cell: number;
}

export interface SelectionRegion {
	readonly anchor: SelectionPoint;
	readonly focus: SelectionPoint;
}

/** 选区反显：只切换反显属性，底下原有的前景色与底色都保留。 */
const SELECT_ON = "\x1b[7m";
const SELECT_OFF = "\x1b[27m";

/**
 * 把屏幕上的 1 基行列换算成选区端点。
 *
 * 行号由滚动窗口映射回视图行；列落在行尾之后时夹到最后一个字符，避免拖过空白把行号算到
 * 下一行。可见区域之外或空白填充行返回 undefined。
 */
export function selectionPoint(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
	column: number,
): SelectionPoint | undefined {
	const line = lineIndexAtRow(view, height, scrollTop, row);
	if (line === undefined || line >= view.lines.length) return undefined;
	const width = displayWidth(stripTerminalStyles(view.lines[line] ?? ""));
	const cell = Math.max(0, Math.min(column - 1, Math.max(0, width - 1)));
	return { line, cell };
}

/** 选区是否真的跨过一段内容；原地点击与双击没有选区，不该触发复制。 */
export function selectionSpans(selection: SelectionRegion): boolean {
	return selection.anchor.line !== selection.focus.line || selection.anchor.cell !== selection.focus.cell;
}

/** 按阅读顺序排好端点：从后往前拖也是同一段文本。 */
export function orderedSelection(selection: SelectionRegion): {
	readonly start: SelectionPoint;
	readonly end: SelectionPoint;
} {
	const { anchor, focus } = selection;
	const reversed = anchor.line > focus.line || (anchor.line === focus.line && anchor.cell > focus.cell);
	return reversed ? { start: focus, end: anchor } : { start: anchor, end: focus };
}

/**
 * 选区里的纯文本。
 *
 * 每行去掉尾部补齐空白的空格：行宽是排版用的，复制出去不该带着一截空白。中间行的结尾空格
 * 同样清掉，但行首缩进保留，粘贴回编辑器时相对层级还在。
 */
export function selectionText(view: TranscriptView, selection: SelectionRegion): string {
	const { start, end } = orderedSelection(selection);
	const lines: string[] = [];
	for (let index = start.line; index <= end.line && index < view.lines.length; index += 1) {
		const plain = stripTerminalStyles(view.lines[index] ?? "");
		const from = index === start.line ? start.cell : 0;
		const to = index === end.line ? end.cell : Number.MAX_SAFE_INTEGER;
		lines.push(sliceCells(plain, from, to).replace(/[ \t]+$/u, ""));
	}
	return lines.join("\n");
}

/** 某一行与选区的交集；不在选区里返回 undefined。行内列按显示宽度计算。 */
export function selectionRange(
	line: number,
	selection: SelectionRegion,
): { readonly from: number; readonly to: number } | undefined {
	const { start, end } = orderedSelection(selection);
	if (line < start.line || line > end.line) return undefined;
	return {
		from: line === start.line ? start.cell : 0,
		to: line === end.line ? end.cell : Number.MAX_SAFE_INTEGER,
	};
}

/**
 * 给一行的指定列范围套上反显。
 *
 * 渲染后的行里夹着颜色、下划线、OSC 8 链接等转义序列。选区内的重置序列会把反显一起清掉，
 * 因此每遇到一个转义就在后面补一次反显；离开范围时只关闭反显，不重置其他属性。
 */
export function highlightSelection(
	line: string,
	range: { readonly from: number; readonly to: number },
): string {
	let out = "";
	let cell = 0;
	let active = false;
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\x1b") {
			const length = escapeLength(line, index);
			out += line.slice(index, index + length);
			if (active) out += SELECT_ON;
			index += length;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(index) ?? 0);
		const width = characterWidth(char);
		const selected = cell >= range.from && cell <= range.to;
		if (selected !== active) {
			out += selected ? SELECT_ON : SELECT_OFF;
			active = selected;
		}
		out += char;
		cell += width;
		index += char.length;
	}
	return active ? `${out}${SELECT_OFF}` : out;
}

/** 清掉一行里的 CSI（颜色等）与 OSC（超链接）序列，只留下屏幕上的字符。 */
export function stripTerminalStyles(line: string): string {
	let out = "";
	let index = 0;
	while (index < line.length) {
		if (line[index] !== "\x1b") {
			out += line[index];
			index += 1;
			continue;
		}
		index += escapeLength(line, index);
	}
	return out;
}

/** 从 ESC 开始的一段转义序列长度；无法完整识别时至少吞掉 ESC 本身。 */
function escapeLength(line: string, index: number): number {
	const next = line[index + 1];
	if (next === "[") {
		let cursor = index + 2;
		while (cursor < line.length) {
			const code = line.charCodeAt(cursor);
			if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
			cursor += 1;
		}
		return line.length - index;
	}
	if (next === "]") {
		let cursor = index + 2;
		while (cursor < line.length) {
			if (line[cursor] === "\x07") return cursor - index + 1;
			if (line[cursor] === "\x1b" && line[cursor + 1] === "\\") return cursor - index + 2;
			cursor += 1;
		}
		return line.length - index;
	}
	return Math.min(2, line.length - index);
}

/** 按显示列截取一段文字；宽字符整字保留，不会切出半个。 */
function sliceCells(text: string, from: number, to: number): string {
	let out = "";
	let cell = 0;
	for (const char of text) {
		const width = characterWidth(char);
		if (cell >= from && cell <= to) out += char;
		cell += width;
		if (cell > to) break;
	}
	return out;
}
