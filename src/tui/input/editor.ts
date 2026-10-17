import {
	cellsOf,
	concat,
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

export class LineEditor {
	#clusters: readonly string[] = [];
	#cursor = 0;
	#history: string[] = [];
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
		// 换行折成空格：输入框只有一行，不折的话内容会与显示对不上
		const inserted = text.replaceAll(/\r\n?|\n/g, " ");
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
		this.#clusters = [
			...this.#clusters.slice(0, this.#cursor - 1),
			...this.#clusters.slice(this.#cursor),
		];
		this.#cursor -= 1;
		this.#resetHistoryCursor();
	}

	deleteForward(): void {
		if (this.#cursor >= this.#clusters.length) return;
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
		this.#clusters = [...this.#clusters.slice(0, start), ...this.#clusters.slice(this.#cursor)];
		this.#cursor = start;
		this.#resetHistoryCursor();
	}

	/** 删掉光标之前的内容（readline 的 Ctrl+U）。 */
	deleteToStart(): void {
		if (this.#cursor === 0) return;
		this.#clusters = this.#clusters.slice(this.#cursor);
		this.#cursor = 0;
		this.#resetHistoryCursor();
	}

	/** 删掉光标之后的内容（readline 的 Ctrl+K）。 */
	deleteToEnd(): void {
		if (this.#cursor >= this.#clusters.length) return;
		this.#clusters = this.#clusters.slice(0, this.#cursor);
		this.#resetHistoryCursor();
	}

	moveLeft(): void {
		this.#cursor = Math.max(0, this.#cursor - 1);
	}

	moveRight(): void {
		this.#cursor = Math.min(this.#clusters.length, this.#cursor + 1);
	}

	moveHome(): void {
		this.#cursor = 0;
	}

	moveEnd(): void {
		this.#cursor = this.#clusters.length;
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
		return text;
	}

	/** 渲染输入区。光标位置由换行结果反推，与显示完全一致。 */
	render(options: EditorRenderOptions): EditorRender {
		const promptCells = cellsOf(options.prompt);

		if (this.#clusters.length === 0 && options.placeholder !== undefined) {
			return {
				lines: wrapLine(mapLine(plain(options.placeholder), (style) => mergeStyles(style, { dim: true })), {
					width: options.width,
					firstIndent: options.prompt,
					restIndent: options.prompt,
				}),
				cursor: { row: 0, col: Math.min(sumCellsWidth(promptCells), Math.max(0, options.width - 1)) },
			};
		}

		const before = this.#clusters.slice(0, this.#cursor).join("");
		const caretCluster = this.#clusters[this.#cursor];
		const after = this.#clusters.slice(this.#cursor + 1).join("");
		const line = concat(
			plain(before),
			// 光标由终端自己画，不在内容里反显；末尾补一格空白，光标才有落点，也才能在最右列换行
			plain(caretCluster ?? " "),
			plain(after),
		);

		// 提示符作为缩进传入而不是拼进内容：它是带尾随空格的，拼进内容会被当成断点，
		// 结果就是提示符自己占一行
		const wrapped = wrapCells(cellsOf(line), {
			width: options.width,
			firstIndent: options.prompt,
			restIndent: options.prompt,
		});
		const row = lineOfCaret(wrapped, this.#cursor);
		const offset = promptCells.length + (this.#cursor - wrapped[row].sourceStart);

		return {
			lines: wrapped.map((item) => lineOfCells(item.cells)),
			cursor: { row, col: sumCellsWidth(wrapped[row].cells.slice(0, Math.max(0, offset))) },
		};
	}

	#setText(text: string): void {
		this.#clusters = segmentGraphemes(text);
		this.#cursor = this.#clusters.length;
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
