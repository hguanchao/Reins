import type { Line } from "../text/line.ts";
import type { TerminalDevice } from "../terminal/terminal.ts";
import { serializeLine } from "./style.ts";

/**
 * 活动区。
 *
 * 界面上只有「还没定型」的内容放在活动区里：正在流式输出的回答、输入框、状态行。已完成的
 * 内容一经提交就永久写进终端的滚动区，此后不再重画——用终端自带的回滚缓冲保存历史，比
 * 自己维护一份可滚动视图更省事，也更符合使用者的习惯（鼠标滚轮、复制、搜索都还能用）。
 *
 * 不闪烁靠两点：一是每次重画只擦掉活动区自己占的那几行，绝不整屏清空；二是把一帧的所有
 * 字节拼成一次写入交给终端，避免终端把中间状态也画出来。
 *
 * 擦除依赖「上一帧占了几行」这个记忆。窗口缩放时终端多半会重排已有内容，这个记忆可能对不
 * 上，因此缩放之后的重画按最保守的方式做：先按记住的行数回退擦除，再按新宽度重画。极少数
 * 会重排的终端上可能残留一行旧内容，代价远小于把已提交的历史擦掉。
 */

export interface LiveFrame {
	readonly lines: readonly Line[];
	/** 光标位置，行号从 0 起，列按显示列算；省略表示把光标留在活动区末尾。 */
	readonly cursor?: { readonly row: number; readonly col: number };
}

export class LiveRegion {
	readonly #device: TerminalDevice;
	readonly #colors: boolean;
	/** 上一次画出去的行数，擦除时按它回退 */
	#drawn = 0;
	#live: LiveFrame = { lines: [] };

	constructor(device: TerminalDevice, options: { readonly colors: boolean }) {
		this.#device = device;
		this.#colors = options.colors;
	}

	/** 画一帧。内容与上一帧一致时一个字节都不写——重复写入正是闪烁的来源。 */
	draw(frame: LiveFrame): void {
		if (sameFrame(this.#live, frame)) return;
		this.#live = frame;
		this.#device.write(this.#erase() + this.#render(frame));
	}

	/** 把内容永久写进滚动区，随后把当前活动区重画在它下面。 */
	commit(lines: readonly Line[]): void {
		if (lines.length === 0) return;

		let text = this.#erase();
		for (const line of lines) text += `${serializeLine(line, this.#colors)}\r\n`;
		this.#device.write(text + this.#render(this.#live));
	}

	/** 擦掉活动区，光标停在它原来的起点。退出前调用，之后屏幕只剩已提交的内容。 */
	clear(): void {
		const text = this.#erase();
		if (text !== "") this.#device.write(text);
	}

	#erase(): string {
		if (this.#drawn === 0) return "";

		// 先清当前行，再逐行上移并清空，最后光标停在活动区第一列
		let text = "\r\x1b[2K";
		for (let index = 1; index < this.#drawn; index += 1) text += "\x1b[1A\r\x1b[2K";
		this.#drawn = 0;
		return text;
	}

	#render(frame: LiveFrame): string {
		let text = "";
		frame.lines.forEach((line, index) => {
			text += `\r\x1b[2K${serializeLine(line, this.#colors)}`;
			if (index < frame.lines.length - 1) text += "\r\n";
		});

		const cursor = frame.cursor;
		if (cursor !== undefined) {
			const up = frame.lines.length - 1 - cursor.row;
			if (up > 0) text += `\x1b[${up}A`;
			// 用绝对列定位而不是逐格右移：宽字符占两列，按显示列算出的绝对列才不会偏
			text += `\x1b[${cursor.col + 1}G`;
		}

		this.#drawn = frame.lines.length;
		return text;
	}
}

function sameFrame(left: LiveFrame, right: LiveFrame): boolean {
	if (left.cursor?.row !== right.cursor?.row || left.cursor?.col !== right.cursor?.col) return false;
	if (left.lines.length !== right.lines.length) return false;

	return left.lines.every((line, index) => sameLine(line, right.lines[index]));
}

function sameLine(left: Line, right: Line): boolean {
	if (left.length !== right.length) return false;
	return left.every((span, index) => {
		const other = right[index];
		return span.text === other.text && sameStyle(span.style, other.style);
	});
}

function sameStyle(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...keys].every(
		(key) => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key],
	);
}
