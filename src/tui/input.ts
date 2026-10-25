import { MENU_MAX_VISIBLE, keepVisible } from "./panel/menu-panel.ts";
import type { ApprovalAnswer } from "../permission/policy.ts";

/**
 * 终端输入解析与单行/多行编辑器。
 *
 * 按键序列、鼠标事件与文本编辑都是无状态的纯函数：输入进来、结果出去。界面状态机只决定
 * 何时调用它们，不再自己解析转义序列。
 */

/** SGR 鼠标协议:滚轮向上与向下的按钮码。 */
export const MOUSE_WHEEL_UP = 64;
export const MOUSE_WHEEL_DOWN = 65;
/** 按钮码低两位是真实按键编号:0 是左键,掩出来为 0 才算点击。 */
export const MOUSE_BUTTON_MASK = 3;

export type ApprovalKey = ApprovalAnswer | "left" | "right" | "enter" | "escape";

/** 审批按键：左右移动、回车确认；y/a/n 仍可直接执行，Esc 拒绝。 */
export function approvalKey(text: string, canAlways: boolean): ApprovalKey | undefined {
	if (text.includes("\x1b[D") || text.includes("\x1bOD")) return "left";
	if (text.includes("\x1b[C") || text.includes("\x1bOC")) return "right";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	if (text === "\x1b") return "escape";

	const lower = text.toLowerCase();
	if (lower.includes("y")) return "once";
	if (canAlways && lower.includes("a")) return "always";
	if (lower.includes("n")) return "deny";
	return undefined;
}

/**
 * Shift+Tab 的转义序列。
 *
 * 终端有三种说法：`\x1b[Z`（xterm 一系，含 Windows Terminal）、带修饰键列的
 * `\x1b[1;2Z`、以及 kitty CSI-u 协议下的 `\x1b[9;2u`（9 是制表符码位，2 表示按下
 * Shift）。只认整段精确匹配：粘贴内容被括在成对的粘贴标记里，永远不会恰好等于一个
 * 裸序列；输入里零散的 `[Z` 之类文字也因此不会被当成切换。
 */
export function shiftTabKey(text: string): boolean {
	return text === "\x1b[Z" || text === "\x1b[1;2Z" || text === "\x1b[9;2u";
}

/** 菜单打开时只认这四个键；普通字符与鼠标事件一律忽略。 */
export function menuKey(text: string): "up" | "down" | "enter" | "tab" | "escape" | undefined {
	if (text.includes("\x1b[A") || text.includes("\x1bOA")) return "up";
	if (text.includes("\x1b[B") || text.includes("\x1bOB")) return "down";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	// 只认单独的制表符：粘贴的内容里可能带 \t，不能把整块粘贴当成一次确认
	if (text === "\t") return "tab";
	if (text === "\x1b") return "escape";
	return undefined;
}

/** 输入历史只认完整的方向键序列，避免把粘贴内容里的序列当成翻历史。 */
export function historyKey(text: string): -1 | 1 | undefined {
	if (text === "\x1b[A" || text === "\x1bOA") return -1;
	if (text === "\x1b[B" || text === "\x1bOB") return 1;
	return undefined;
}

/**
 * 撤回或丢弃排队消息的按键：Alt+Up 取回队尾，Alt+Down 直接丢弃。
 *
 * 只认单独到达的序列：方向键本身要给输入历史和光标用，必须靠修饰键把它们分开。
 */
export function queuedEditKey(text: string): "recall" | "discard" | undefined {
	if (text === "\x1b[1;3A" || text === "\x1b[1;9A") return "recall";
	if (text === "\x1b[1;3B" || text === "\x1b[1;9B") return "discard";
	return undefined;
}

/** 对话流滚动键；不与输入行的 Home/End 抢按键。 */
export function scrollKey(text: string): "pageUp" | "pageDown" | "top" | undefined {
	if (text === "\x1b[5~") return "pageUp";
	if (text === "\x1b[6~") return "pageDown";
	if (text === "\x1b[1;5H") return "top";
	return undefined;
}

/** 去掉 SGR 鼠标事件，避免它们被当成普通输入。 */
export function stripMouseEvents(text: string): string {
	return text.replace(/\x1b\[<[0-9;]+[Mm]/g, "");
}

export interface MouseInput {
	readonly button: number;
	readonly column: number;
	readonly row: number;
	/** SGR 的 M 表示按下，m 表示松开 */
	readonly press: boolean;
}

/**
 * 按住键拖动的移动事件。
 *
 * 1003 模式还会上报没按键的纯移动（低两位为 3），那只是指针在挪，不能当成拖动去改选中项。
 */
export function dragMotion(button: number): boolean {
	return button >= 32 && button < 64 && (button & MOUSE_BUTTON_MASK) !== 3;
}

/** 一个菜单面板交给公共鼠标处理器的交互面:命中、当前光标、选中同步、翻动与确认。 */
export interface MenuMouseTarget {
	/** 终端行号命中的条目下标;命中不了(点到面板外或边框上)返回 undefined */
	readonly hitItem: (row: number) => number | undefined;
	readonly cursor: () => number;
	readonly select: (index: number) => void;
	readonly move: (delta: number) => void;
	readonly confirm: () => void;
}

export function mouseEvents(text: string): readonly MouseInput[] {
	const events: MouseInput[] = [];
	for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
		events.push({
			button: Number(match[1]),
			column: Number(match[2]),
			row: Number(match[3]),
			press: match[4] === "M",
		});
	}
	return events;
}

/**
 * 菜单面板的屏幕行对应哪个条目。
 *
 * row 是终端上报的 1 基行号；panelTop 是面板上边框所在的 1 基行号。条目从上边框下一行
 * 开始，所以偏移量是 row - panelTop - 1。
 */
export function menuIndexAtRow(
	row: number,
	panelTop: number,
	itemCount: number,
	scrollTop: number,
	cursor: number,
): number | undefined {
	const visible = Math.min(Math.max(0, itemCount), MENU_MAX_VISIBLE);
	if (visible === 0) return undefined;
	const offset = row - panelTop - 1;
	if (offset < 0 || offset >= visible) return undefined;
	const index = keepVisible(scrollTop, cursor, itemCount) + offset;
	return index < itemCount ? index : undefined;
}

export interface InputEdit {
	readonly text: string;
	readonly cursor: number;
	readonly submit: boolean;
	readonly pasting: boolean;
	readonly handled: boolean;
}

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * 把终端读到的一段字符并进输入框。
 *
 * 支持光标移动、行内 Home/End、删除、bracketed paste 多行粘贴；历史上下键由调用方处理。
 * 转义序列通常在一次读取里完整到达，未识别的序列整段丢弃，不能当成文字填进去。
 */
export function editInput(
	current: string,
	currentCursor: number,
	chunk: string,
	pasting: boolean,
): InputEdit {
	let text = current;
	let cursor = Math.min(Math.max(0, currentCursor), current.length);
	let submit = false;
	let isPasting = pasting;
	let handled = false;

	const insert = (value: string): void => {
		if (value.length === 0) return;
		text = text.slice(0, cursor) + value + text.slice(cursor);
		cursor += value.length;
		handled = true;
	};
	const insertPaste = (value: string): void => {
		insert(value.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
	};

	const applyKey = (sequence: string): void => {
		if (sequence === "\x1b[D" || sequence === "\x1bOD") {
			cursor = previousIndex(text, cursor);
		} else if (sequence === "\x1b[C" || sequence === "\x1bOC") {
			cursor = nextIndex(text, cursor);
		} else if (
			sequence === "\x1b[H" ||
			sequence === "\x1bOH" ||
			sequence === "\x1b[1~" ||
			sequence === "\x1b[7~"
		) {
			cursor = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		} else if (
			sequence === "\x1b[F" ||
			sequence === "\x1bOF" ||
			sequence === "\x1b[4~" ||
			sequence === "\x1b[8~"
		) {
			const end = text.indexOf("\n", cursor);
			cursor = end < 0 ? text.length : end;
		} else if (sequence === "\x1b[3~") {
			const end = nextIndex(text, cursor);
			if (end > cursor) text = text.slice(0, cursor) + text.slice(end);
			handled = true;
		} else {
			return;
		}
		handled = true;
	};

	const normal = (value: string): void => {
		for (let index = 0; index < value.length; index += 1) {
			const char = value[index] ?? "";
			if (char === "\x1b") {
				const rest = value.slice(index);
				const match = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
				if (match !== null) {
					applyKey(match[0]);
					index += match[0].length - 1;
				}
				continue;
			}
			if (char === "\r" || char === "\n") {
				submit = true;
				return;
			}
			if (char === "\x7f" || char === "\b") {
				if (cursor > 0) {
					const start = previousIndex(text, cursor);
					text = text.slice(0, start) + text.slice(cursor);
					cursor = start;
					handled = true;
				}
				continue;
			}
			if (char >= " ") {
				insert(char);
			}
		}
	};

	let index = 0;
	while (index < chunk.length && !submit) {
		if (isPasting) {
			const end = chunk.indexOf(PASTE_END, index);
			if (end < 0) {
				insertPaste(chunk.slice(index));
				index = chunk.length;
				break;
			}
			insertPaste(chunk.slice(index, end));
			isPasting = false;
			index = end + PASTE_END.length;
			continue;
		}

		const start = chunk.indexOf(PASTE_START, index);
		const stop = start < 0 ? chunk.length : start;
		normal(chunk.slice(index, stop));
		if (submit || start < 0) break;

		const end = chunk.indexOf(PASTE_END, start + PASTE_START.length);
		if (end < 0) {
			insertPaste(chunk.slice(start + PASTE_START.length));
			isPasting = true;
			index = chunk.length;
			break;
		}
		insertPaste(chunk.slice(start + PASTE_START.length, end));
		index = end + PASTE_END.length;
	}

	return { text, cursor, submit, pasting: isPasting, handled };
}

function previousIndex(text: string, index: number): number {
	if (index <= 0) return 0;
	const code = text.charCodeAt(index - 1);
	if (code >= 0xdc00 && code <= 0xdfff) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return index - 2;
	}
	return index - 1;
}

function nextIndex(text: string, index: number): number {
	if (index >= text.length) return text.length;
	const code = text.charCodeAt(index);
	if (code >= 0xd800 && code <= 0xdbff) {
		const low = text.charCodeAt(index + 1);
		if (low >= 0xdc00 && low <= 0xdfff) return index + 2;
	}
	return index + 1;
}

/** 多行输入里上下移动光标；单行输入交给历史。 */
export function moveInputVertical(text: string, cursor: number, delta: number): number | undefined {
	const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
	const column = cursor - lineStart;
	if (delta < 0) {
		if (lineStart === 0) return undefined;
		const previousEnd = lineStart - 1;
		const previousStart = text.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
		return previousStart + Math.min(column, previousEnd - previousStart);
	}
	const lineEnd = text.indexOf("\n", cursor);
	if (lineEnd < 0) return undefined;
	const nextStart = lineEnd + 1;
	const nextEnd = text.indexOf("\n", nextStart);
	const end = nextEnd < 0 ? text.length : nextEnd;
	return nextStart + Math.min(column, end - nextStart);
}
