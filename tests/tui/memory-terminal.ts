import { graphemeWidth } from "../../src/tui/text/width.ts";
import type { Terminal, TerminalSize } from "../../src/tui/terminal/terminal.ts";

/**
 * 内存终端。
 *
 * 全屏界面没法在单元测试里真的开一个伪终端，但它的行为又几乎全在「写出去的字节」上。
 * 这里给出两件东西：一个记录写入与模式切换的假终端，和一个把写出去的字节按控制序列还原成
 * 字符网格的模拟屏。有了它们，「活动区擦干净了没有」「光标停在哪」「换行有没有破版」这类
 * 断言才能落在可见结果上，而不是落在字节串上。
 */

/** 假终端：记录每一次写入与每一次模式切换，测试直接对着记录断言。 */
export class MemoryTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly rawModes: boolean[] = [];
	readonly cursorVisibility: boolean[] = [];
	readonly pasteModes: boolean[] = [];
	readonly focusModes: boolean[] = [];
	readonly alternateScreens: boolean[] = [];
	/** 每次缩放发生在第几次写入之后，供重放时按当时的几何尺寸还原 */
	readonly resizes: { readonly at: number; readonly size: TerminalSize }[] = [];

	#size: TerminalSize;
	#inputListener: ((chunk: string) => void) | undefined;
	#resizeListener: (() => void) | undefined;

	constructor(size: TerminalSize = { rows: 12, cols: 40 }) {
		this.#size = size;
	}

	size(): TerminalSize {
		return this.#size;
	}

	write(text: string): void {
		this.writes.push(text);
	}

	onInput(listener: (chunk: string) => void): void {
		this.#inputListener = listener;
	}

	onResize(listener: () => void): void {
		this.#resizeListener = listener;
	}

	setRawMode(enabled: boolean): void {
		this.rawModes.push(enabled);
	}

	setCursorVisible(visible: boolean): void {
		this.cursorVisibility.push(visible);
	}

	setBracketedPaste(enabled: boolean): void {
		this.pasteModes.push(enabled);
	}

	setAlternateScreen(enabled: boolean): void {
		this.write(enabled ? "\x1b[?1049h" : "\x1b[?1049l");
		this.alternateScreens.push(enabled);
	}

	setFocusReporting(enabled: boolean): void {
		this.focusModes.push(enabled);
	}

	/** 模拟用户按键。 */
	feedInput(chunk: string): void {
		this.#inputListener?.(chunk);
	}

	/** 模拟窗口缩放。 */
	resize(size: TerminalSize): void {
		this.resizes.push({ at: this.writes.length, size });
		this.#size = size;
		this.#resizeListener?.();
	}
}

/** 一屏字符。宽字符占两格，右半格记成空串，这样按列对齐的断言与终端一致。 */
interface Cursor {
	row: number;
	col: number;
}

/**
 * 屏幕模拟器。
 *
 * 只认界面真正会发的那几条控制序列：清行、光标上移、绝对列定位、换行回车，以及会滚屏与
 * 自动折行的普通字符。认不出来的序列一律跳过，与终端的行为一致。
 */
export class ScreenEmulator {
	#cols: number;
	#rows: number;

	#grid: string[][];
	#cursor: Cursor = { row: 0, col: 0 };
	/** 光标停在最后一列时，再写一个字符就折到下一行 */
	#pendingWrap = false;
	#scrolled: string[] = [];

	constructor(rows: number, cols: number) {
		this.#rows = rows;
		this.#cols = cols;
		this.#grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(" "));
	}

	get rows(): number {
		return this.#rows;
	}

	get cols(): number {
		return this.#cols;
	}

	/**
	 * 改变尺寸。
	 *
	 * 已有内容按「不回流的终端」处理：行数多了补空行，少了丢掉底部；列宽变化时右侧内容被裁掉。
	 * 真实终端里有的会重排已有的行，但那属于终端自己的行为，界面只保证新画的内容按新宽度排版。
	 */
	resize(rows: number, cols: number): void {
		const grid = Array.from({ length: rows }, (_, row) => {
			const source = this.#grid[row] ?? [];
			const line = new Array<string>(cols).fill(" ");
			for (let col = 0; col < Math.min(cols, source.length); col += 1) line[col] = source[col];
			return line;
		});
		this.#grid = grid;
		this.#rows = rows;
		this.#cols = cols;
		this.#cursor = {
			row: Math.min(this.#cursor.row, rows - 1),
			col: Math.min(this.#cursor.col, cols - 1),
		};
		this.#pendingWrap = false;
	}

	/** 写入一段字节并即时生效。 */
	feed(text: string): void {
		let index = 0;
		while (index < text.length) {
			const char = text[index];
			if (char === "\x1b") {
				index = this.#feedEscape(text, index);
				continue;
			}
			index += 1;
			if (char === "\r") {
				this.#cursor.col = 0;
				this.#pendingWrap = false;
				continue;
			}
			if (char === "\n") {
				this.#lineFeed();
				this.#pendingWrap = false;
				continue;
			}
			this.#put(char);
		}
	}

	/** 当前屏幕上每一行的内容，行尾空白已去掉。 */
	visible(): string[] {
		return this.#grid.map((row) => row.join("").replace(/\s+$/, ""));
	}

	/** 已经被顶出屏幕上方的行。 */
	scrolled(): string[] {
		return [...this.#scrolled];
	}

	cursor(): Cursor {
		return { ...this.#cursor };
	}

	/** 屏幕上的字符，宽字符的右半格记为空串。 */
	cellAt(row: number, col: number): string {
		return this.#grid[row]?.[col] ?? "";
	}

	#feedEscape(text: string, start: number): number {
		// 只处理 CSI：ESC [ 参数 终止符
		if (text[start + 1] !== "[") return start + 2;

		let index = start + 2;
		let params = "";
		while (index < text.length) {
			const char = text[index];
			const code = char.charCodeAt(0);
			if (code >= 0x40 && code <= 0x7e) break;
			params += char;
			index += 1;
		}
		const final = text[index] ?? "";
		const value = Number.parseInt(params.replace(/^\?/, ""), 10);

		switch (final) {
			case "K": {
				// 2K：清整行
				const row = this.#grid[this.#cursor.row];
				if (row !== undefined) row.fill(" ");
				this.#pendingWrap = false;
				break;
			}
			case "A":
				this.#cursor.row = Math.max(0, this.#cursor.row - (Number.isNaN(value) ? 1 : value));
				this.#pendingWrap = false;
				break;
			case "B":
				this.#cursor.row = Math.min(this.#rows - 1, this.#cursor.row + (Number.isNaN(value) ? 1 : value));
				this.#pendingWrap = false;
				break;
			case "G":
				this.#cursor.col = Math.min(this.#cols - 1, Math.max(0, (Number.isNaN(value) ? 1 : value) - 1));
				this.#pendingWrap = false;
				break;
			default:
				// 其余都是样式与模式开关，对字符网格没有影响
				break;
		}

		return index + 1;
	}

	#lineFeed(): void {
		this.#cursor.row += 1;
		if (this.#cursor.row < this.#rows) return;

		// 到底了：整屏上移一行，被顶出去的那行进回滚缓冲
		const [first, ...rest] = this.#grid;
		this.#scrolled.push((first ?? []).join("").replace(/\s+$/, ""));
		this.#grid = [...rest, new Array<string>(this.#cols).fill(" ")];
		this.#cursor.row = this.#rows - 1;
	}

	#put(char: string): void {
		const width = graphemeWidth(char);
		if (width === 0) return;

		if (this.#pendingWrap) {
			this.#cursor.col = 0;
			this.#lineFeed();
			this.#pendingWrap = false;
		}
		// 宽字符放不下当前行时也会折行，与真实终端的自动折行一致
		if (this.#cursor.col + width > this.#cols) {
			this.#cursor.col = 0;
			this.#lineFeed();
		}

		const row = this.#grid[this.#cursor.row];
		if (row !== undefined) {
			row[this.#cursor.col] = char;
			if (width === 2) row[this.#cursor.col + 1] = "";
		}
		this.#cursor.col += width;
		if (this.#cursor.col >= this.#cols) {
			this.#cursor.col = this.#cols - 1;
			this.#pendingWrap = true;
		}
	}
}

/** 把假终端写过的所有字节重放到一块屏幕上，途中遇到缩放就按新尺寸继续。 */
export function screenOf(terminal: MemoryTerminal, size?: TerminalSize): ScreenEmulator {
	const current = size ?? terminal.size();
	const screen = new ScreenEmulator(current.rows, current.cols);

	terminal.writes.forEach((chunk, index) => {
		for (const resize of terminal.resizes) {
			if (resize.at === index) screen.resize(resize.size.rows, resize.size.cols);
		}
		screen.feed(chunk);
	});
	return screen;
}
