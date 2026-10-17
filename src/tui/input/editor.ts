import {
	cellsOf,
	lineOfCells,
	mapLine,
	mergeStyles,
	plain,
	sumCellsWidth,
	type Line,
} from "../text/line.ts";
import { segmentGraphemes } from "../text/width.ts";
import { wrapCells, wrapLine } from "../text/wrap.ts";

/**
 * 单行输入编辑器。
 *
 * 文本按字素簇保存：光标移动、退格都该以「一个字」为单位，按码位删除会把 emoji 或带声调的
 * 字母删掉一半。所以内部是一串簇，取字符串时才拼起来。
 *
 * 内容只占一行，粘贴进来的换行折成空格。多行编辑需要一整套纵向滚动与光标上下移动的规则，
 * 而这里要的只是「把一句话交给模型」，把换行折成空格更接近使用者的意图，也少一整类边界情形。
 */

export interface EditorRender {
	readonly lines: readonly Line[];
	/** 光标位置，行号从 0 起，列按显示列算 */
	readonly cursor: { readonly row: number; readonly col: number };
}

export interface EditorRenderOptions {
	/** 可用列数 */
	readonly width: number;
	/** 提示符。折行后的行也用它对齐，视觉上仍是一整块输入区。 */
	readonly prompt: Line;
	/** 内容为空时显示的灰色提示 */
	readonly placeholder?: string;
}

/** 一段以换行分隔的逻辑行。 */
interface LogicalLine {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export class LineEditor {
	#clusters: readonly string[] = [];
	#cursor = 0;
	#history: string[] = [];
	/** 编辑前的快照，Ctrl+Z 逐次回退。 */
	#undoStack: { readonly clusters: readonly string[]; readonly cursor: number }[] = [];
	#redoStack: { readonly clusters: readonly string[]; readonly cursor: number }[] = [];
	/** 开始翻历史之前记下的草稿，翻回最后一条时恢复它 */
	#draft: string | undefined;
	/** 当前处在历史里的位置；-1 表示不在翻历史 */
	#historyIndex = -1;

	get text(): string {
		return this.#clusters.join("");
	}

	get isEmpty(): boolean {
		return this.#clusters.length === 0;
	}

	insert(text: string): void {
		// 只统一换行符，保留换行：输入框支持多行，粘贴进来的换行不再折成空格
		const inserted = text.replaceAll(/\r\n?/g, "\n");
		if (inserted.length === 0) return;
		this.#snapshot();
		const before = this.#clusters.slice(0, this.#cursor).join("");
		const after = this.#clusters.slice(this.#cursor).join("");
		const merged = segmentGraphemes(before + inserted + after);
		// 光标位置按「插入点之前有几个簇」重新算：插入的内容可能与前一个簇合成一个簇
		this.#cursor = segmentGraphemes(before + inserted).length;
		this.#clusters = merged;
		this.#resetHistoryCursor();
	}

	backspace(): void {
		if (this.#cursor === 0) return;
		this.#snapshot();
		this.#clusters = [
			...this.#clusters.slice(0, this.#cursor - 1),
			...this.#clusters.slice(this.#cursor),
		];
		this.#cursor -= 1;
		this.#resetHistoryCursor();
	}

	deleteForward(): void {
		if (this.#cursor >= this.#clusters.length) return;
		this.#snapshot();
		this.#clusters = [
			...this.#clusters.slice(0, this.#cursor),
			...this.#clusters.slice(this.#cursor + 1),
		];
		this.#resetHistoryCursor();
	}

	/** 删除光标前的一个词，包括它前面的空白。 */
	deleteWordBefore(): void {
		let start = this.#cursor;
		while (start > 0 && isSpace(this.#clusters[start - 1])) start -= 1;
		while (start > 0 && !isSpace(this.#clusters[start - 1])) start -= 1;
		if (start === this.#cursor) return;
		this.#snapshot();
		this.#clusters = [...this.#clusters.slice(0, start), ...this.#clusters.slice(this.#cursor)];
		this.#cursor = start;
		this.#resetHistoryCursor();
	}

	/** 删掉光标之前的内容（readline 的 Ctrl+U），只到当前行首。 */
	deleteToStart(): void {
		const { line } = this.#cursorLine();
		if (this.#cursor <= line.start) return;
		this.#snapshot();
		this.#clusters = [...this.#clusters.slice(0, line.start), ...this.#clusters.slice(this.#cursor)];
		this.#cursor = line.start;
		this.#resetHistoryCursor();
	}

	/** 删掉光标之后的内容（readline 的 Ctrl+K），只到当前行尾。 */
	deleteToEnd(): void {
		const { line } = this.#cursorLine();
		if (this.#cursor >= line.end) return;
		this.#snapshot();
		this.#clusters = [...this.#clusters.slice(0, this.#cursor), ...this.#clusters.slice(line.end)];
		this.#resetHistoryCursor();
	}

	/** 撤销一次编辑。 */
	undo(): void {
		const previous = this.#undoStack.pop();
		if (previous === undefined) return;
		this.#redoStack.push({ clusters: this.#clusters, cursor: this.#cursor });
		this.#clusters = previous.clusters;
		this.#cursor = previous.cursor;
		this.#resetHistoryCursor();
	}

	/** 重做一次撤销过的编辑。 */
	redo(): void {
		const next = this.#redoStack.pop();
		if (next === undefined) return;
		this.#undoStack.push({ clusters: this.#clusters, cursor: this.#cursor });
		this.#clusters = next.clusters;
		this.#cursor = next.cursor;
		this.#resetHistoryCursor();
	}

	moveLeft(): void {
		this.#cursor = Math.max(0, this.#cursor - 1);
	}

	moveRight(): void {
		this.#cursor = Math.min(this.#clusters.length, this.#cursor + 1);
	}

	/** 移到当前逻辑行的行首。 */
	moveHome(): void {
		this.#cursor = this.#cursorLine().line.start;
	}

	/** 移到当前逻辑行的行尾（换行符之前）。 */
	moveEnd(): void {
		this.#cursor = this.#cursorLine().line.end;
	}

	/** 移到上一逻辑行的同一列；已经在首行则不动。 */
	moveUp(): void {
		const { lines, index, local } = this.#cursorLine();
		if (index === 0) return;
		const target = lines[index - 1];
		this.#cursor = target.start + Math.min(local, target.end - target.start);
		this.#resetHistoryCursor();
	}

	/** 移到下一逻辑行的同一列；已经在末行则不动。 */
	moveDown(): void {
		const { lines, index, local } = this.#cursorLine();
		const target = lines[index + 1];
		if (target === undefined) return;
		this.#cursor = target.start + Math.min(local, target.end - target.start);
		this.#resetHistoryCursor();
	}

	/** 光标前的反斜杠换成换行（命令续行）；没有反斜杠时返回 false。 */
	insertNewlineAfterContinuation(): boolean {
		if (this.#cursor === 0 || this.#clusters[this.#cursor - 1] !== "\\") return false;
		this.#snapshot();
		this.#clusters = [
			...this.#clusters.slice(0, this.#cursor - 1),
			"\n",
			...this.#clusters.slice(this.#cursor),
		];
		this.#resetHistoryCursor();
		return true;
	}

	/** 上一条历史。走到最早一条时停住，不绕回去。 */
	historyPrev(): void {
		if (this.#history.length === 0) return;
		if (this.#historyIndex === -1) {
			this.#historyIndex = this.#history.length;
			this.#draft = this.text;
		}
		if (this.#historyIndex === 0) return;
		this.#historyIndex -= 1;
		this.#setText(this.#history[this.#historyIndex]);
	}

	/** 下一条历史。走过最新一条时回到翻历史之前打的草稿。 */
	historyNext(): void {
		if (this.#historyIndex === -1) return;
		this.#historyIndex += 1;
		if (this.#historyIndex >= this.#history.length) {
			this.#historyIndex = -1;
			this.#setText(this.#draft ?? "");
			this.#draft = undefined;
			return;
		}
		this.#setText(this.#history[this.#historyIndex]);
	}

	/** 清空内容，但保留历史。 */
	clear(): void {
		if (this.#clusters.length === 0) return;
		this.#snapshot();
		this.#clusters = [];
		this.#cursor = 0;
		this.#resetHistoryCursor();
	}

	/** 取出内容并压入历史。返回刚才那句话。 */
	submit(): string {
		const text = this.text;
		if (text.trim().length > 0 && this.#history[this.#history.length - 1] !== text) {
			this.#history.push(text);
		}
		this.clear();
		// 已经发出去的内容不再通过撤销捞回来
		this.#undoStack.length = 0;
		this.#redoStack.length = 0;
		return text;
	}

	/** 渲染输入区。光标位置由换行结果反推，与显示完全一致。 */
	render(options: EditorRenderOptions): EditorRender {
		const promptCells = cellsOf(options.prompt);
		const promptWidth = sumCellsWidth(promptCells);

		if (this.#clusters.length === 0 && options.placeholder !== undefined) {
			return {
				lines: wrapLine(mapLine(plain(options.placeholder), (style) => mergeStyles(style, { dim: true })), {
					width: options.width,
					firstIndent: options.prompt,
					restIndent: options.prompt,
				}),
				cursor: { row: 0, col: Math.min(promptWidth, Math.max(0, options.width - 1)) },
			};
		}

		const logical = this.#logicalLines();
		const cursorLine = this.#cursorLine();
		const indent = plain(" ".repeat(promptWidth));
		const lines: Line[] = [];
		let cursorRow = 0;
		let cursorCol = promptWidth;

		logical.forEach((line, index) => {
			const isCursor = index === cursorLine.index;
			const local = isCursor ? cursorLine.local : 0;
			// 光标在行尾时补一格空白，光标才有落点；中间位置直接落在字符格上
			const content = isCursor && local === line.text.length ? `${line.text} ` : line.text;
			const wrapped = wrapCells(cellsOf(plain(content)), {
				width: options.width,
				firstIndent: index === 0 ? options.prompt : indent,
				restIndent: indent,
			});

			if (isCursor) {
				const row = lineOfCaret(wrapped, local);
				const offset = promptWidth + (local - wrapped[row].sourceStart);
				cursorRow = lines.length + row;
				cursorCol = sumCellsWidth(wrapped[row].cells.slice(0, Math.max(0, offset)));
			}
			lines.push(...wrapped.map((item) => lineOfCells(item.cells)));
		});

		return { lines, cursor: { row: cursorRow, col: cursorCol } };
	}

	/** 按换行符切成逻辑行；末尾换行会产生一个空行。 */
	#logicalLines(): readonly LogicalLine[] {
		const lines: LogicalLine[] = [];
		let start = 0;
		for (let index = 0; index < this.#clusters.length; index += 1) {
			if (this.#clusters[index] !== "\n") continue;
			lines.push({ start, end: index, text: this.#clusters.slice(start, index).join("") });
			start = index + 1;
		}
		lines.push({ start, end: this.#clusters.length, text: this.#clusters.slice(start).join("") });
		return lines;
	}

	/** 光标所在逻辑行；正好在新行符上时算作前一行的行尾。 */
	#cursorLine(): { lines: readonly LogicalLine[]; index: number; line: LogicalLine; local: number } {
		const lines = this.#logicalLines();
		let index = lines.length - 1;
		for (let cursor = 0; cursor < lines.length; cursor += 1) {
			if (this.#cursor <= lines[cursor].end) {
				index = cursor;
				break;
			}
		}
		const line = lines[index];
		return {
			lines,
			index,
			line,
			local: Math.max(0, Math.min(this.#cursor, line.end) - line.start),
		};
	}

	#setText(text: string): void {
		if (text === this.text) {
			this.#cursor = this.#clusters.length;
			return;
		}
		this.#snapshot();
		this.#clusters = segmentGraphemes(text);
		this.#cursor = this.#clusters.length;
	}

	#snapshot(): void {
		this.#undoStack.push({ clusters: this.#clusters, cursor: this.#cursor });
		if (this.#undoStack.length > 100) this.#undoStack.shift();
		this.#redoStack.length = 0;
	}

	#resetHistoryCursor(): void {
		this.#historyIndex = -1;
		this.#draft = undefined;
	}
}

/** 找出光标所在的行：最后一个起点不晚于光标位置的行。 */
function lineOfCaret(
	lines: readonly { readonly sourceStart: number }[],
	caretIndex: number,
): number {
	let found = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].sourceStart <= caretIndex) found = index;
	}
	return found;
}

function isSpace(cluster: string): boolean {
	return cluster.trim().length === 0;
}
