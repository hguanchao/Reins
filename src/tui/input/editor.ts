import {
	cellsOf,
	lineOfCells,
	mapLine,
	mergeStyles,
	plain,
	sumCellsWidth,
	type Line,
	type Span,
	type Style,
} from "../text/line.ts";
import { segmentGraphemes } from "../text/width.ts";
import { wrapCells, wrapLine } from "../text/wrap.ts";

/**
 * 输入编辑器。
 *
 * 文本按字素簇保存：光标移动、退格都该以「一个字」为单位，按码位删除会把 emoji 或带声调的
 * 字母删掉一半。普通文本是若干文本原子；粘贴 chip 是单独一种原子，显示成一行标签，但内部
 * 保存完整内容。这样光标移动、退格和删除词都会把 chip 当成一个整体，提交时才展开。
 *
 * 内容可以有多行：换行是普通文本原子，渲染时按逻辑行分别排版。
 */

export interface EditorRender {
	readonly lines: readonly Line[];
	/** 光标位置，行号从 0 起，列按显示列算 */
	readonly cursor: { readonly row: number; readonly col: number };
	/** 粘贴 chip 在渲染结果里的位置，供鼠标命中测试。 */
	readonly elements: readonly EditorElement[];
}

/** 一个粘贴 chip 在某一行上占据的列范围；跨行时会有多条。 */
export interface EditorElement {
	readonly id: number;
	/** 行号从 0 起，列与 render 的行内列一致（含提示符缩进）。 */
	readonly row: number;
	readonly col: number;
	readonly width: number;
}

export interface EditorRenderOptions {
	/** 可用列数 */
	readonly width: number;
	/** 提示符。折行后的行也用它对齐，视觉上仍是一整块输入区。 */
	readonly prompt: Line;
	/** 内容为空时显示的灰色提示 */
	readonly placeholder?: string;
	/** 粘贴 chip 的样式；不传则用普通文字。 */
	readonly pasteStyle?: Style;
	/** 最多显示几行；超出时只保留包含光标的一段，输入区内部滚动。 */
	readonly maxRows?: number;
}

/** 一段普通文本原子：一个输入字素簇。 */
interface TextAtom {
	readonly kind: "text";
	readonly text: string;
}

/** 一个粘贴 chip：显示标签，提交时展开成完整内容。 */
interface PasteAtom {
	readonly kind: "paste";
	/** 稳定标识：鼠标双击要按它找到对应的原子，编辑后下标会变。 */
	readonly id: number;
	readonly text: string;
	readonly label: string;
}

type Atom = TextAtom | PasteAtom;

/** 一段以换行分隔的逻辑行；首尾都是原子下标，end 不含。 */
interface LogicalLine {
	readonly start: number;
	readonly end: number;
}

export class LineEditor {
	#atoms: readonly Atom[] = [];
	#cursor = 0;
	#nextElementId = 1;
	#history: string[] = [];
	/** 编辑前的快照，Ctrl+Z 逐次回退。 */
	#undoStack: { readonly atoms: readonly Atom[]; readonly cursor: number }[] = [];
	#redoStack: { readonly atoms: readonly Atom[]; readonly cursor: number }[] = [];
	/** 开始翻历史之前记下的草稿，翻回最后一条时恢复它 */
	#draft: string | undefined;
	/** 当前处在历史里的位置；-1 表示不在翻历史 */
	#historyIndex = -1;

	/** 完整内容：粘贴 chip 展开后的文本。 */
	get text(): string {
		return this.#atoms.map((atom) => atom.text).join("");
	}

	/** 屏幕上的样子：粘贴 chip 只显示标签。 */
	get displayText(): string {
		return this.#atoms.map(atomText).join("");
	}

	/** 光标之前的显示文本；斜杠下拉靠它判断命令名是否还在输入中。 */
	get displayBeforeCursor(): string {
		return this.#atoms.slice(0, this.#cursor).map(atomText).join("");
	}

	get isEmpty(): boolean {
		return this.#atoms.length === 0;
	}

	insert(text: string): void {
		// 只统一换行符，保留换行：输入框支持多行，粘贴进来的换行不再折成空格
		const inserted = normalizeLineBreaks(text);
		if (inserted.length === 0) return;
		this.#snapshot();
		this.#insertGraphemes(this.#cursor, segmentGraphemes(inserted));
		this.#resetHistoryCursor();
	}

	/** 插入一个粘贴 chip；完整内容保存在原子里，屏幕上只占一行标签。 */
	insertElement(text: string, label: string): void {
		const normalized = normalizeLineBreaks(text);
		if (normalized.length === 0 || label.length === 0) return;
		this.#snapshot();
		this.#atoms = [
			...this.#atoms.slice(0, this.#cursor),
			{ kind: "paste", id: this.#nextElementId++, text: normalized, label },
			...this.#atoms.slice(this.#cursor),
		];
		this.#cursor += 1;
		this.#resetHistoryCursor();
	}

	/**
	 * 替换开头的一段显示文本。
	 *
	 * 斜杠补全用它把 `/he` 换成 `/help `。只接受落在原子边界上的长度；命令名是普通文本，
	 * 不会跨过粘贴 chip。
	 */
	replacePrefix(length: number, replacement: string): void {
		if (length <= 0) return;

		let consumed = 0;
		let cutoff = 0;
		while (cutoff < this.#atoms.length && consumed < length) {
			consumed += atomText(this.#atoms[cutoff]).length;
			cutoff += 1;
		}
		if (consumed !== length) return;

		this.#snapshot();
		const inserted: Atom[] = segmentGraphemes(normalizeLineBreaks(replacement)).map((text) => ({
			kind: "text",
			text,
		}));
		this.#atoms = [...inserted, ...this.#atoms.slice(cutoff)];
		this.#cursor = inserted.length;
		this.#resetHistoryCursor();
	}

	/**
	 * 展开光标前或光标后的粘贴 chip。
	 *
	 * 传入 expected 时只在内容完全一致时展开：再次粘贴同一段内容表示「我不要 chip，展开它」。
	 * 返回是否真的展开了。
	 */
	expandPasteAtCursor(expected?: string): boolean {
		for (const index of [this.#cursor, this.#cursor - 1]) {
			const atom = this.#atoms[index];
			if (atom === undefined || atom.kind !== "paste") continue;
			if (expected !== undefined && atom.text !== expected) continue;
			return this.#expandPasteIndex(index);
		}
		return false;
	}

	/** 按稳定 id 展开 chip；供鼠标双击使用，返回是否找到。 */
	expandPasteElement(id: number): boolean {
		const index = this.#atoms.findIndex((atom) => atom.kind === "paste" && atom.id === id);
		return index < 0 ? false : this.#expandPasteIndex(index);
	}

	#expandPasteIndex(index: number): boolean {
		const atom = this.#atoms[index];
		if (atom === undefined || atom.kind !== "paste") return false;

		this.#snapshot();
		const expanded: Atom[] = segmentGraphemes(atom.text).map((text) => ({ kind: "text", text }));
		this.#atoms = [...this.#atoms.slice(0, index), ...expanded, ...this.#atoms.slice(index + 1)];
		this.#cursor = index + expanded.length;
		this.#resetHistoryCursor();
		return true;
	}

	backspace(): void {
		if (this.#cursor === 0) return;
		this.#snapshot();
		this.#removeAtoms(this.#cursor - 1, this.#cursor);
		this.#cursor -= 1;
		this.#resetHistoryCursor();
	}

	deleteForward(): void {
		if (this.#cursor >= this.#atoms.length) return;
		this.#snapshot();
		this.#removeAtoms(this.#cursor, this.#cursor + 1);
		this.#resetHistoryCursor();
	}

	/** 删除光标前的一个词，包括它前面的空白。 */
	deleteWordBefore(): void {
		let start = this.#cursor;
		while (start > 0 && isSpace(atomText(this.#atoms[start - 1]))) start -= 1;
		while (start > 0 && !isSpace(atomText(this.#atoms[start - 1]))) start -= 1;
		if (start === this.#cursor) return;
		this.#snapshot();
		this.#removeAtoms(start, this.#cursor);
		this.#cursor = start;
		this.#resetHistoryCursor();
	}

	/** 删掉光标之前的内容（readline 的 Ctrl+U），只到当前行首。 */
	deleteToStart(): void {
		const { line } = this.#cursorLine();
		if (this.#cursor <= line.start) return;
		this.#snapshot();
		this.#removeAtoms(line.start, this.#cursor);
		this.#cursor = line.start;
		this.#resetHistoryCursor();
	}

	/** 删掉光标之后的内容（readline 的 Ctrl+K），只到当前行尾。 */
	deleteToEnd(): void {
		const { line } = this.#cursorLine();
		if (this.#cursor >= line.end) return;
		this.#snapshot();
		this.#removeAtoms(this.#cursor, line.end);
		this.#resetHistoryCursor();
	}

	/** 撤销一次编辑。 */
	undo(): void {
		const previous = this.#undoStack.pop();
		if (previous === undefined) return;
		this.#redoStack.push({ atoms: this.#atoms, cursor: this.#cursor });
		this.#atoms = previous.atoms;
		this.#cursor = previous.cursor;
		this.#resetHistoryCursor();
	}

	/** 重做一次撤销过的编辑。 */
	redo(): void {
		const next = this.#redoStack.pop();
		if (next === undefined) return;
		this.#undoStack.push({ atoms: this.#atoms, cursor: this.#cursor });
		this.#atoms = next.atoms;
		this.#cursor = next.cursor;
		this.#resetHistoryCursor();
	}

	moveLeft(): void {
		this.#cursor = Math.max(0, this.#cursor - 1);
	}

	moveRight(): void {
		this.#cursor = Math.min(this.#atoms.length, this.#cursor + 1);
	}

	/** 移到当前逻辑行的行首。 */
	moveHome(): void {
		this.#cursor = this.#cursorLine().line.start;
	}

	/** 移到当前逻辑行的行尾（换行符之前）。 */
	moveEnd(): void {
		this.#cursor = this.#cursorLine().line.end;
	}

	/** 移到上一逻辑行的同一位置；已经在首行则不动。 */
	moveUp(): void {
		const { lines, index, local } = this.#cursorLine();
		if (index === 0) return;
		const target = lines[index - 1];
		this.#cursor = target.start + Math.min(local, target.end - target.start);
		this.#resetHistoryCursor();
	}

	/** 移到下一逻辑行的同一位置；已经在末行则不动。 */
	moveDown(): void {
		const { lines, index, local } = this.#cursorLine();
		const target = lines[index + 1];
		if (target === undefined) return;
		this.#cursor = target.start + Math.min(local, target.end - target.start);
		this.#resetHistoryCursor();
	}

	/** 光标前的反斜杠换成换行（命令续行）；没有反斜杠时返回 false。 */
	insertNewlineAfterContinuation(): boolean {
		const previous = this.#atoms[this.#cursor - 1];
		if (previous === undefined || previous.kind !== "text" || previous.text !== "\\") return false;
		this.#snapshot();
		this.#atoms = [
			...this.#atoms.slice(0, this.#cursor - 1),
			{ kind: "text", text: "\n" },
			...this.#atoms.slice(this.#cursor),
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
		if (this.#atoms.length === 0) return;
		this.#snapshot();
		this.#atoms = [];
		this.#cursor = 0;
		this.#resetHistoryCursor();
	}

	/** 取出内容并压入历史。返回刚才那句话，粘贴 chip 已展开。 */
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

		if (this.#atoms.length === 0 && options.placeholder !== undefined) {
			return {
				lines: wrapLine(mapLine(plain(options.placeholder), (style) => mergeStyles(style, { dim: true })), {
					width: options.width,
					firstIndent: options.prompt,
					restIndent: options.prompt,
				}),
				cursor: { row: 0, col: Math.min(promptWidth, Math.max(0, options.width - 1)) },
				elements: [],
			};
		}

		const logical = this.#logicalLines();
		const cursorLine = this.#cursorLine();
		const indent = plain(" ".repeat(promptWidth));
		const lines: Line[] = [];
		const elements: EditorElement[] = [];
		let cursorRow = 0;
		let cursorCol = promptWidth;

		logical.forEach((line, index) => {
			const isCursor = index === cursorLine.index;
			const local = isCursor ? cursorLine.local : 0;
			const content = this.#lineOfAtoms(line.start, line.end, options.pasteStyle);
			// 光标在行尾时补一格空白，光标才有落点；中间位置直接落在字符格上
			const display =
				isCursor && local === line.end - line.start ? [...content, { text: " " }] : content;
			const wrapped = wrapCells(cellsOf(display), {
				width: options.width,
				firstIndent: index === 0 ? options.prompt : indent,
				restIndent: indent,
			});
			const rowBase = lines.length;

			if (isCursor) {
				const before = this.#lineOfAtoms(line.start, line.start + local, options.pasteStyle);
				const caret = cellsOf(before).length;
				const row = lineOfCaret(wrapped, caret);
				const offset = caret - wrapped[row].sourceStart;
				cursorRow = rowBase + row;
				cursorCol = sumCellsWidth(wrapped[row].cells.slice(0, promptWidth + Math.max(0, offset)));
			}

			for (const chip of this.#chipsInLine(line)) {
				for (let row = 0; row < wrapped.length; row += 1) {
					const contentCells = wrapped[row].cells.length - promptWidth;
					const rowStart = wrapped[row].sourceStart;
					const from = Math.max(chip.start, rowStart);
					const to = Math.min(chip.start + chip.width, rowStart + contentCells);
					if (to <= from) continue;
					elements.push({
						id: chip.id,
						row: rowBase + row,
						col: promptWidth + (from - rowStart),
						width: to - from,
					});
				}
			}

			lines.push(...wrapped.map((item) => lineOfCells(item.cells)));
		});

		const start = viewportStart(lines.length, cursorRow, options.maxRows);
		const visible = options.maxRows === undefined ? lines : lines.slice(start, start + options.maxRows);
		const visibleElements =
			options.maxRows === undefined
				? elements
				: elements
						.filter((element) => element.row >= start && element.row < start + visible.length)
						.map((element) => ({ ...element, row: element.row - start }));
		return {
			lines: visible,
			cursor: { row: cursorRow - start, col: cursorCol },
			elements: visibleElements,
		};
	}

	/** 一个逻辑行里各粘贴 chip 的显示区间，单位是这一行的内容格。 */
	#chipsInLine(line: LogicalLine): readonly { id: number; start: number; width: number }[] {
		const chips: { id: number; start: number; width: number }[] = [];
		let offset = 0;
		for (let index = line.start; index < line.end; index += 1) {
			const atom = this.#atoms[index];
			if (atom.kind === "text") {
				offset += segmentGraphemes(atom.text).length;
				continue;
			}
			const width = segmentGraphemes(atom.label).length;
			chips.push({ id: atom.id, start: offset, width });
			offset += width;
		}
		return chips;
	}

	/** 把一段原子拼成带样式的显示行；粘贴 chip 用标签代替完整内容。 */
	#lineOfAtoms(start: number, end: number, pasteStyle: Style | undefined): Line {
		const spans: Span[] = [];
		for (let index = start; index < end; index += 1) {
			const atom = this.#atoms[index];
			if (atom.kind === "text") {
				spans.push({ text: atom.text });
			} else {
				spans.push(pasteStyle === undefined ? { text: atom.label } : { text: atom.label, style: pasteStyle });
			}
		}
		return spans;
	}

	/** 按换行符切成逻辑行；末尾换行会产生一个空行。 */
	#logicalLines(): readonly LogicalLine[] {
		const lines: LogicalLine[] = [];
		let start = 0;
		for (let index = 0; index < this.#atoms.length; index += 1) {
			const atom = this.#atoms[index];
			if (atom.kind !== "text" || atom.text !== "\n") continue;
			lines.push({ start, end: index });
			start = index + 1;
		}
		lines.push({ start, end: this.#atoms.length });
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

	/**
	 * 在光标处插入字素簇。
	 *
	 * 插入点两侧的文本会一并重新分段：组合用重音可能与相邻字符合成一个字素簇，不重新算就会
	 * 在退格时只删掉半个字。粘贴 chip 是分段边界，不在合并范围内。
	 */
	#insertGraphemes(index: number, graphemes: readonly string[]): void {
		let start = index;
		while (start > 0 && this.#atoms[start - 1].kind === "text") start -= 1;
		let end = index;
		while (end < this.#atoms.length && this.#atoms[end].kind === "text") end += 1;

		const before = this.#atoms.slice(start, index).map((atom) => atom.text).join("");
		const after = this.#atoms.slice(index, end).map((atom) => atom.text).join("");
		const inserted = graphemes.join("");
		const merged: Atom[] = segmentGraphemes(before + inserted + after).map((text) => ({ kind: "text", text }));
		this.#atoms = [...this.#atoms.slice(0, start), ...merged, ...this.#atoms.slice(end)];
		this.#cursor = start + segmentGraphemes(before + inserted).length;
	}

	#removeAtoms(start: number, end: number): void {
		this.#atoms = [...this.#atoms.slice(0, start), ...this.#atoms.slice(end)];
	}

	#setText(text: string): void {
		if (text === this.text) {
			this.#cursor = this.#atoms.length;
			return;
		}
		this.#snapshot();
		this.#atoms = segmentGraphemes(text).map((value) => ({ kind: "text", text: value }));
		this.#cursor = this.#atoms.length;
	}

	#snapshot(): void {
		this.#undoStack.push({ atoms: this.#atoms, cursor: this.#cursor });
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

function atomText(atom: Atom): string {
	return atom.kind === "text" ? atom.text : atom.label;
}

/** 输入区只看一段时，尽量把光标放在中间；靠近首尾时贴边。 */
function viewportStart(total: number, cursor: number, maxRows: number | undefined): number {
	if (maxRows === undefined || total <= maxRows) return 0;
	const target = cursor - Math.floor(maxRows / 2);
	return Math.max(0, Math.min(total - maxRows, target));
}

function isSpace(atom: string): boolean {
	return atom.trim().length === 0;
}

function normalizeLineBreaks(text: string): string {
	return text.replaceAll(/\r\n?/g, "\n");
}
