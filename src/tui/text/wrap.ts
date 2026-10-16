import {
	cellsOf,
	lineOfCells,
	sumCellsWidth,
	type Cell,
	type CellLine,
	type Line,
} from "./line.ts";
import { ELLIPSIS, fitCells } from "./truncate.ts";

/**
 * 按列宽换行。
 *
 * 输入是格子而不是字符串：宽度已经在建格子时算过，换行时只做加法，不必再回到字素簇那一层
 * 反复测量。缩进也做成格子，这样悬挂缩进（列表项、代码块）与正文走的是同一套宽度计算。
 *
 * 断行的取舍：优先在空格处断，没有空格可断（长单词、中文、路径）才硬断。中日韩文字本来
 * 就可以在任意两字之间断开，硬断不算难看；而把一个长路径从中间劈开总好过让它冲出屏幕。
 *
 * 断点处的空格留在上一行而不是丢掉：丢掉会让下一行的行首位置取决于源文本里空格的多少，
 * 代码块的缩进会因此在折行处消失。多出来的行尾空格不影响观感，也不会挤掉别的列。
 */

export interface WrapOptions {
	/** 每行最多占多少列 */
	readonly width: number;
	/** 首行的缩进 */
	readonly firstIndent?: Line;
	/** 折行后各行的缩进 */
	readonly restIndent?: Line;
	/** 最多保留几行，超出部分丢掉并在末行末尾加省略号 */
	readonly maxLines?: number;
}

/** 制表位宽度。终端默认 8 列，这里按同一约定展开，免得宽度计算与实际显示对不上。 */
const TAB_WIDTH = 8;

const LINE_FEEDS = new Set(["\n", "\r", "\r\n"]);

/**
 * 换行。
 *
 * 返回的每行都带着缩进，宽度是实际占用的列数——单字宽于整行时它会超过给定宽度，
 * 这是唯一允许超出的情形：此时无论怎么排都放不下。
 */
export function wrapCells(cells: readonly Cell[], options: WrapOptions): readonly CellLine[] {
	const { width } = options;
	if (!Number.isInteger(width) || width < 1) {
		throw new Error(`换行宽度必须是正整数，收到 ${width}`);
	}
	if (options.maxLines !== undefined && options.maxLines < 1) {
		throw new Error(`最多行数必须是正整数，收到 ${options.maxLines}`);
	}

	const firstIndent = options.firstIndent === undefined ? [] : [...cellsOf(options.firstIndent)];
	const restIndent = options.restIndent === undefined ? [] : [...cellsOf(options.restIndent)];
	const indentWidth = sumCellsWidth(restIndent);
	const lines: CellLine[] = [];

	let current: Cell[] = [...firstIndent];
	let currentWidth = sumCellsWidth(firstIndent);
	/** 本行缩进之后的起点；在此之前不许断，否则会把缩进单独留在一行 */
	let contentStart = current.length;
	let lastBreak = -1;
	/** 自上次断行以来是否放过内容，用于判断输入末尾的换行要不要产生一个空行 */
	let dirty = false;

	const flush = (): void => {
		lines.push({ cells: current, width: currentWidth });
		current = [...restIndent];
		currentWidth = indentWidth;
		contentStart = restIndent.length;
		lastBreak = -1;
		dirty = false;
	};

	const place = (cell: Cell): void => {
		while (currentWidth + cell.width > width && current.length > contentStart) {
			if (lastBreak > contentStart) {
				const tail = current.slice(lastBreak);
				lines.push({ cells: current.slice(0, lastBreak), width: currentWidth - sumCellsWidth(tail) });
				current = [...restIndent, ...tail];
				currentWidth = indentWidth + sumCellsWidth(tail);
			} else {
				lines.push({ cells: current, width: currentWidth });
				current = [...restIndent];
				currentWidth = indentWidth;
			}
			// 新一行的可断起点在缩进之后：缩进自己不能被单独留在上一行
			contentStart = restIndent.length;
			lastBreak = -1;
		}

		current.push(cell);
		currentWidth += cell.width;
		// 断点记在空格之后：断在那里等于把这个空格留在上一行
		if (cell.text === " ") lastBreak = current.length;
		dirty = true;
	};

	for (const cell of cells) {
		if (LINE_FEEDS.has(cell.text)) {
			flush();
			continue;
		}
		if (cell.text === "\t") {
			// 空格的个数要先算定：place 会改当前列宽，边放边算会把制表位越缩越短
			const count = TAB_WIDTH - (currentWidth % TAB_WIDTH);
			for (let index = 0; index < count; index += 1) {
				place({ text: " ", width: 1, style: cell.style });
			}
			continue;
		}
		place(cell);
	}

	// 末尾的换行只表示「这一行结束了」，不该再凭空多出一个空行；空输入则保留一行
	if (dirty || lines.length === 0) lines.push({ cells: current, width: currentWidth });
	return applyMaxLines(lines, width, options.maxLines);
}

export function wrapLine(line: Line, options: WrapOptions): readonly Line[] {
	return wrapCells(cellsOf(line), options).map((wrapped) => lineOfCells(wrapped.cells));
}

/** 超出保留行数时，在末行末尾加省略号，提示后面还有内容。 */
function applyMaxLines(
	lines: readonly CellLine[],
	width: number,
	maxLines: number | undefined,
): readonly CellLine[] {
	if (maxLines === undefined || lines.length <= maxLines) return lines;

	const kept = lines.slice(0, maxLines);
	const last = kept[kept.length - 1];
	const trimmed = fitCells(last.cells, width - 1);
	const cells = [...trimmed, { text: ELLIPSIS, width: 1 }];
	return [...kept.slice(0, -1), { cells, width: sumCellsWidth(cells) }];
}
