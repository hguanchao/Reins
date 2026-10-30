import { characterWidth, displayWidth, graphemes } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";
import { lineIndexAtRow } from "#src/tui/transcript/scroll.ts";
import { PLAIN_LINE_META } from "#src/tui/transcript/types.ts";
import type { TranscriptView } from "#src/tui/transcript/types.ts";

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

/** 行首默认前景/底色；离开选区时恢复行内最后见到的设置。 */
const DEFAULT_FG = "\x1b[39m";
const DEFAULT_BG = "\x1b[49m";

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
	const width = visibleTextWidth(view.lines[line] ?? "");
	const contentStart = Math.min(view.lineMeta[line]?.contentStart ?? 0, Math.max(0, width - 1));
	const cell = Math.max(contentStart, Math.min(column - 1, Math.max(0, width - 1)));
	return { line, cell };
}

/** 一行真正有字的显示宽度：行尾补齐的空格不算可选内容。 */
export function visibleTextWidth(line: string): number {
	return displayWidth(stripTerminalStyles(line).trimEnd());
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
 * 每行从内容起点开始取，跳过详情色带的行号与缩进；软换行出来的续行直接接回上一条逻辑行，
 * 不因为终端宽度插进换行。每行末尾补齐的空白同样清掉，但行首缩进保留。
 *
 * 「还有 N 行未显示」这类省略提示不是内容本身：它只是屏幕放不下的记号，复制时跳过，
 * 免得粘到别处还要手动删一行。
 */
export function selectionText(view: TranscriptView, selection: SelectionRegion): string {
	const { start, end } = orderedSelection(selection);
	const lines: string[] = [];
	for (let index = start.line; index <= end.line && index < view.lines.length; index += 1) {
		const meta = view.lineMeta[index] ?? PLAIN_LINE_META;
		const plain = stripTerminalStyles(view.lines[index] ?? "");
		const width = visibleTextWidth(view.lines[index] ?? "");
		const from =
			index === start.line ? Math.max(start.cell, Math.min(meta.contentStart, width)) : meta.contentStart;
		const to = Math.min(index === end.line ? end.cell : width - 1, width - 1);
		const piece = from > to ? "" : sliceCells(plain, from, to);
		if (meta.softWrap && lines.length > 0) {
			lines[lines.length - 1] += piece;
			continue;
		}
		if (ELLIPSIS_ROW.test(piece.trim())) continue;
		lines.push(piece);
	}
	return lines.map((line) => line.replace(/[ \t]+$/u, "")).join("\n");
}

/** 折叠块末尾的省略提示：`… (12 more lines · Ctrl+G)`。 */
const ELLIPSIS_ROW = /^… \(\d+ more lines(?: · .+)?\)$/u;

/**
 * 某一行与选区的交集；不在选区里或这一行没有文字时返回 undefined。
 *
 * 右侧边界夹在最后一个可见字符上：行宽是为了排版补齐的，把行尾空白也画成选中会让一段
 * 两行的选择在第一行变成整行色块。文本本身仍由 selectionText 按行提取。
 */
export function selectionRange(
	line: number,
	selection: SelectionRegion,
	textWidth: number,
	contentStart = 0,
): { readonly from: number; readonly to: number } | undefined {
	const { start, end } = orderedSelection(selection);
	if (line < start.line || line > end.line) return undefined;
	// 这一行只有行号或只有色带留白：没有正文可选，连行号也不该高亮
	if (textWidth <= contentStart) return undefined;
	const limit = textWidth - 1;
	const first = contentStart;
	const fromCell = line === start.line ? Math.min(start.cell, limit) : first;
	const from = Math.max(fromCell, first);
	const to = Math.min(line === end.line ? end.cell : limit, limit);
	return from > to ? undefined : { from, to };
}

/**
 * 给一行的指定列范围套上选区底色。
 *
 * 渲染后的行里夹着颜色、色带底色、OSC 8 链接等转义序列。进入选区时换成深色字配浅色底；
 * 选区内的转义（尤其是重置）可能把颜色清掉，因此每遇到一个转义就补一次选区样式。离开
 * 选区时恢复这一行最后见到的前景色与底色，色带与提示块不会被选区永久改色。
 */
export function highlightSelection(
	line: string,
	range: { readonly from: number; readonly to: number },
): string {
	let out = "";
	let cell = 0;
	let active = false;
	let foreground = DEFAULT_FG;
	let background = DEFAULT_BG;
	// 按字素簇推进：转义序列不占列，其余每个簇整体着色，emoji 不会被拆成两半
	const segments = graphemes(line);
	let segment = 0;
	let segmentStart = 0;
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\x1b") {
			const length = escapeLength(line, index);
			const sequence = line.slice(index, index + length);
			out += sequence;
			const nextFg = foregroundOf(sequence);
			if (nextFg !== undefined) foreground = nextFg;
			const nextBg = backgroundOf(sequence);
			if (nextBg !== undefined) background = nextBg;
			if (active) out += THEME.selectionFg + THEME.selectionBg;
			index += length;
			// 跳过转义序列覆盖到的字素段，下一次取字符时仍落在完整簇边界上
			while (segment < segments.length && segmentStart + (segments[segment] ?? "").length <= index) {
				segmentStart += (segments[segment] ?? "").length;
				segment += 1;
			}
			continue;
		}
		const char = segments[segment] ?? "";
		if (char.length === 0) break;
		const width = characterWidth(char);
		const selected = cell >= range.from && cell <= range.to;
		if (selected !== active) {
			active = selected;
			out += active ? THEME.selectionFg + THEME.selectionBg : foreground + background;
		}
		out += char;
		cell += width;
		index += char.length;
		segmentStart += char.length;
		segment += 1;
	}
	return active ? `${out}${foreground}${background}` : out;
}

/**
 * 一条 SGR 序列设置的新前景色；不涉及前景色时返回 undefined。
 *
 * 只认设置前景色的参数（30–37、90–97、38;5;n、38;2;r;g;b）与重置（0、39）。加粗、下划线
 * 等属性不在此处理，选区只替换颜色。
 */
function foregroundOf(sequence: string): string | undefined {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return undefined;
	const body = sequence.slice(2, -1);
	if (body.length === 0) return DEFAULT_FG;
	const params = body.split(";");
	let foreground: string | undefined;
	for (let index = 0; index < params.length; index += 1) {
		const param = params[index] ?? "";
		if (param === "0" || param === "39") {
			foreground = DEFAULT_FG;
			continue;
		}
		if (param === "38") {
			const mode = params[index + 1];
			if (mode === "5" && params[index + 2] !== undefined) {
				foreground = `\x1b[38;5;${params[index + 2]}m`;
				index += 2;
				continue;
			}
			if (mode === "2" && params[index + 4] !== undefined) {
				foreground = `\x1b[38;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
				index += 4;
			}
			continue;
		}
		const code = Number(param);
		if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			foreground = `\x1b[${code}m`;
		}
	}
	return foreground;
}

/**
 * 一条 SGR 序列设置的新底色；不涉及底色时返回 undefined。
 *
 * 只认设置底色的参数（40–47、100–107、48;5;n、48;2;r;g;b）与重置（0、49）。前景色、
 * 加粗与下划线都与选区底色无关，离开选区后不需要重放。
 */
function backgroundOf(sequence: string): string | undefined {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return undefined;
	const body = sequence.slice(2, -1);
	if (body.length === 0) return DEFAULT_BG;
	const params = body.split(";");
	let background: string | undefined;
	for (let index = 0; index < params.length; index += 1) {
		const param = params[index] ?? "";
		if (param === "0" || param === "49") {
			background = DEFAULT_BG;
			continue;
		}
		if (param === "48") {
			const mode = params[index + 1];
			if (mode === "5" && params[index + 2] !== undefined) {
				background = `\x1b[48;5;${params[index + 2]}m`;
				index += 2;
				continue;
			}
			if (mode === "2" && params[index + 4] !== undefined) {
				background = `\x1b[48;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
				index += 4;
			}
			continue;
		}
		const code = Number(param);
		if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
			background = `\x1b[${code}m`;
		}
	}
	return background;
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
	for (const char of graphemes(text)) {
		const width = characterWidth(char);
		if (cell >= from && cell <= to) out += char;
		cell += width;
		if (cell > to) break;
	}
	return out;
}
