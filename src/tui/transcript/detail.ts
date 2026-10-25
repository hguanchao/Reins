import type { ResultDetailKind } from "../../tools/result-detail.ts";
import { highlightCode, type SyntaxSegment } from "../../tools/syntax.ts";
import { characterWidth, displayWidth, truncateToWidth, wrapText } from "../text.ts";
import { THEME } from "../theme.ts";
import { syntaxColor } from "../syntax-style.ts";
import {
	DETAIL_BAND_MAX_LINES,
	DETAIL_BAND_LEFT,
	DETAIL_RIGHT_PADDING,
	MIN_DETAIL_CONTENT,
	RESET,
	TAB_STOP,
} from "./style.ts";
import type { TranscriptTool } from "./types.ts";

/** 一段带颜色的文本；着色只到这一段为止，渲染完要回到调用方给的颜色。 */
export interface ColoredSegment {
	readonly text: string;
	readonly color: string;
}

/** 展开的详情色带：上下各留一行，右侧铺到面板边缘。失败行展开时也复用它。 */
export function detailBand(tool: TranscriptTool, baseIndent: string, width: number): readonly string[] {
	const bandStart = displayWidth(baseIndent) + DETAIL_BAND_LEFT;
	const kind = tool.detailKind ?? "text";
	// 工具结果普遍以换行结尾，直接切行会在详情末尾多出一个空行，与下边距叠成两行留白
	const rows = stripTrailingBlank((tool.fullDetail ?? "").split("\n"));
	// 只截显示不截数据：全文仍在 tool.fullDetail 里，展开多长都不会把这一轮的其他内容挤出屏幕
	const visible = rows.slice(0, DETAIL_BAND_MAX_LINES).map(expandTabs);
	const syntax =
		kind === "diff"
			? diffSyntax(visible, tool.detail)
			: kind === "file"
				? fileSyntax(visible, tool.detail)
				: undefined;
	const hidden = rows.length - visible.length;
	return [
		bandBlankLine(width, bandStart),
		...visible.flatMap((line, index) =>
			detailBodyLines(line, kind, width, bandStart, detailColor(kind, line), syntax?.[index]),
		),
		...(hidden === 0
			? []
			: detailBodyLines(
					`… (${hidden} more lines)`,
					"text",
					width,
					bandStart,
					THEME.textSubtle,
					undefined,
				)),
		bandBlankLine(width, bandStart),
	];
}

/**
 * 去掉末尾的空行。
 *
 * 工具结果常以换行结尾，切行后最后一项是空串；渲染时它会占掉一整行，与面板本来的下边距
 * 叠在一起，看起来就像底部莫名多了两行留白。
 */
export function stripTrailingBlank(rows: readonly string[]): readonly string[] {
	let end = rows.length;
	while (end > 0 && (rows[end - 1] ?? "").trim().length === 0) end -= 1;
	return end === rows.length ? rows : rows.slice(0, end);
}

/** 按固定制表位展开制表符；换行由调用方先切好，这里只处理行内。 */
export function expandTabs(text: string): string {
	let column = 0;
	let output = "";
	for (const char of text) {
		if (char === "\t") {
			const width = TAB_STOP - (column % TAB_STOP);
			output += " ".repeat(width);
			column += width;
			continue;
		}
		output += char;
		column += characterWidth(char);
	}
	return output;
}

/**
 * 详情行：文件与 diff 带行号，续行按行号后的内容列悬挂缩进；其余按正文折行。
 *
 * bandStart 是色带起点，内容在带内留一列内边距后开始。
 */
export function detailBodyLines(
	line: string,
	kind: ResultDetailKind,
	width: number,
	bandStart: number,
	color: string,
	syntax: readonly SyntaxSegment[] | undefined,
): readonly string[] {
	if (kind === "file") {
		const match = /^(\s*\d+  )(.*)$/.exec(line);
		if (match !== null) {
			const segments =
				syntax === undefined
					? [{ text: match[2] ?? "", color }]
					: syntax.map((segment) => ({
							text: segment.text,
							// 没有角色的标点保持正文色，别把整行提亮成白色
							color: segment.token === undefined ? color : syntaxColor(segment.token),
						}));
			return hangingLines(
				match[1] ?? "",
				"",
				segments,
				width,
				bandStart,
				THEME.detailBg,
				THEME.textSubtle,
				color,
				DETAIL_RIGHT_PADDING,
			);
		}
	}
	if (kind === "diff") {
		const match = /^(\s*\d+ )([-+] |  )(.*)$/.exec(line);
		if (match !== null) {
			const marker = match[2] ?? "  ";
			// 增删由整行底色表示，代码本身按语法着色；认不出语言时退回正文色
			const background =
				marker === "+ " ? THEME.diffInsertBg : marker === "- " ? THEME.diffDeleteBg : THEME.detailBg;
			// 行号跟着增删走：一眼能分出这一行的归属，不必来回对标记列
			const markerColor = marker === "+ " ? THEME.success : marker === "- " ? THEME.error : color;
			const segments =
				syntax === undefined
					? [{ text: match[3] ?? "", color }]
					: syntax.map((segment) => ({ text: segment.text, color: syntaxColor(segment.token) }));
			return hangingLines(
				match[1] ?? "",
				marker,
				segments,
				width,
				bandStart,
				background,
				markerColor,
				markerColor,
				DETAIL_RIGHT_PADDING,
			);
		}
	}
	return bandedWrappedLines(
		line,
		width,
		color,
		bandStart,
		DETAIL_RIGHT_PADDING,
	);
}

/**
 * diff 里的代码着色。
 *
 * 一份 diff 交错着两个版本：删行属于旧文件、增行属于新文件。块注释、模板字符串这类跨行结构
 * 必须各自在自己的版本里解析，否则颜色会在增删交界处串味，因此新旧两侧各解析一次再按行映射
 * 回来。认不出语言时返回 undefined，调用方按纯文本渲染。
 *
 * fileName 是折叠行里的文件名：语言只按扩展名判断，去掉目录不影响结论。
 */
export function diffSyntax(
	rows: readonly string[],
	fileName: string,
): readonly (readonly SyntaxSegment[] | undefined)[] | undefined {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	const slots: ({ readonly side: "old" | "new"; readonly index: number } | undefined)[] = [];

	for (const row of rows) {
		const match = /^(\s*\d+ )([-+] |  )(.*)$/.exec(row);
		if (match === null) {
			slots.push(undefined);
			continue;
		}
		const marker = match[2] ?? "  ";
		const text = match[3] ?? "";
		if (marker === "- ") {
			slots.push({ side: "old", index: oldLines.length });
			oldLines.push(text);
			continue;
		}
		// 新增行与上下文行都属于新版本；上下文行同时补进旧版本，两侧才能保持完整
		slots.push({ side: "new", index: newLines.length });
		newLines.push(text);
		if (marker === "  ") oldLines.push(text);
	}

	const oldParsed = oldLines.length === 0 ? undefined : highlightCode(oldLines.join("\n"), fileName);
	const newParsed = newLines.length === 0 ? undefined : highlightCode(newLines.join("\n"), fileName);
	if (oldParsed === undefined && newParsed === undefined) return undefined;

	return slots.map((slot) => {
		if (slot === undefined) return undefined;
		return (slot.side === "old" ? oldParsed : newParsed)?.[slot.index];
	});
}

/**
 * 文件内容的语法着色。
 *
 * 带行号的正文按行号后的内容列重建整段代码再解析，行号与省略行不进入源码：跨行结构
 * 只有整段解析才能判对。行号宽度由预览层决定，这里只按「数字 + 两个空格」剥离。
 */
export function fileSyntax(
	rows: readonly string[],
	fileName: string,
): readonly (readonly SyntaxSegment[] | undefined)[] | undefined {
	const code: string[] = [];
	const slots: (number | undefined)[] = [];
	for (const row of rows) {
		const match = /^\s*\d+  (.*)$/.exec(row);
		if (match === null) {
			slots.push(undefined);
			continue;
		}
		slots.push(code.length);
		code.push(match[1] ?? "");
	}
	if (code.length === 0) return undefined;

	const parsed = highlightCode(code.join("\n"), fileName);
	if (parsed === undefined) return undefined;
	return slots.map((slot) => (slot === undefined ? undefined : parsed[slot]));
}

/** 面板上下内边距：整条色带，不写内容。 */
export function bandBlankLine(width: number, bandStart: number): string {
	const start = Math.max(0, Math.min(bandStart, width));
	const lead = " ".repeat(start);
	return `${lead}${THEME.detailBg}${" ".repeat(Math.max(0, width - start))}${RESET}`;
}

/** 带行号的行换行时，续行缩进到行号之后的内容列。 */
export function hangingLines(
	gutter: string,
	marker: string,
	segments: readonly ColoredSegment[],
	width: number,
	bandStart: number,
	background: string,
	gutterColor: string,
	markerColor: string,
	rightPadding: number,
): readonly string[] {
	const start = Math.max(0, Math.min(bandStart, width));
	const contentEnd = Math.max(start, width - rightPadding);
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, contentEnd - start);

	// 行号与增删标记属于刻度而不是内容，压暗后正文才成为视觉主体。
	// 终端过窄时前缀会宽过整条色带：此时按「留白 → 行号 → 标记」依次让步，
	// 至少给正文留一列，否则整行会被推出终端宽度，或者正文整段消失。
	const minContent = Math.min(MIN_DETAIL_CONTENT, innerWidth);
	let head = "";
	let headWidth = 0;
	const append = (text: string, color: string | undefined): void => {
		if (text.length === 0) return;
		const room = innerWidth - minContent - headWidth;
		if (room <= 0) return;
		const visible = truncateToWidth(text, room);
		if (visible.length === 0) return;
		head += color === undefined ? visible : `${color}${visible}`;
		headWidth += displayWidth(visible);
	};
	append(" ", undefined);
	// 行号跟随增删色：改动的归属看一眼行号列就够，不必再去对标记
	append(gutter, gutterColor);
	append(marker, markerColor);

	const available = Math.max(1, innerWidth - headWidth);
	const wrapped = wrapSegments(segments, available);
	const continuation = " ".repeat(headWidth);

	return wrapped.map((line, index) => {
		const body = paintSegments(index === 0 ? head : continuation, headWidth, line, innerWidth);
		// 底色要铺满整行：行尾补齐用背景色而不是文字色，否则尾部会拖一条彩色的空白
		const padding = " ".repeat(Math.max(0, width - start - body.width));
		return `${lead}${background}${body.text}${padding}${RESET}`;
	});
}

/** 详情行换行后同样从 bandStart 列开始铺色带，带内留一列内边距。 */
export function bandedWrappedLines(
	text: string,
	width: number,
	color: string,
	bandStart: number,
	rightPadding: number,
): readonly string[] {
	const start = Math.max(0, Math.min(bandStart, width));
	const contentEnd = Math.max(start, width - rightPadding);
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, contentEnd - start);
	// 带内留白由这里固定给出一列，不能从前缀里推导：色带起点一变，前缀就会被切光。
	// 但窄终端上留白不能把正文挤没，宽度不够时让出来。
	const insideWidth = innerWidth > MIN_DETAIL_CONTENT ? 1 : 0;
	const inside = " ".repeat(insideWidth);
	const lines = wrapText(text, Math.max(0, innerWidth - insideWidth));
	const continuation = inside;

	return lines.map((line, index) => {
		const content = `${index === 0 ? inside : continuation}${line}`;
		const visible = truncateToWidth(content, innerWidth);
		// 空行与 hunk 之间的省略行不写内容，只留底色；给它们上文字色会在整行铺出一片色块
		const paint = visible.trim().length === 0 ? "" : color;
		const padding = " ".repeat(Math.max(0, width - start - displayWidth(visible)));
		return `${lead}${THEME.detailBg}${paint}${visible}${padding}${RESET}`;
	});
}

/** 详情行的颜色：diff 的增、删分别着色，省略行弱化，文件内容用次要文字色。 */
export function detailColor(kind: ResultDetailKind, line: string): string {
	if (kind === "diff") {
		// 带行号的 diff 形如 `12 + added` / `12 - removed`
		const marker = /^\s*\d+ ([-+]) /.exec(line);
		if (marker !== null) return marker[1] === "+" ? THEME.success : THEME.error;
		// 两个 hunk 之间的省略行不是正文，弱化到背景里
		if (line.trimStart().startsWith("…")) return THEME.textSubtle;
		if (line.startsWith("+")) return THEME.success;
		if (line.startsWith("-")) return THEME.error;
		return THEME.textSecondary;
	}
	if (kind === "file") return THEME.textSecondary;
	return THEME.textPrimary;
}

/**
 * 按显示宽度折行，保留每段的颜色。
 *
 * 着色后的代码由多段不同颜色拼成，先摊成字符再按宽度切断，切点落在段中间时要把这段拆开，
 * 否则整段会因为放不下而被整体推到下一行，行宽就白算了。
 */
function wrapSegments(segments: readonly ColoredSegment[], limit: number): readonly (readonly ColoredSegment[])[] {
	if (limit <= 0) return [[]];

	const lines: ColoredSegment[][] = [[]];
	let used = 0;

	for (const segment of segments) {
		for (const char of segment.text) {
			const charWidth = characterWidth(char);
			if (used + charWidth > limit && used > 0) {
				lines.push([]);
				used = 0;
			}
			appendColored(lines[lines.length - 1] ?? [], char, segment.color);
			used += charWidth;
		}
	}
	return lines;
}

/** 相邻同色字符合并，避免输出里出现大量只有一两个字符的转义序列。 */
function appendColored(line: ColoredSegment[], text: string, color: string): void {
	const last = line.at(-1);
	if (last !== undefined && last.color === color) {
		line[line.length - 1] = { text: last.text + text, color };
		return;
	}
	line.push({ text, color });
}

/**
 * 把前缀与彩色正文拼成一行，并按宽度截断。
 *
 * 截断必须按字符进行：着色后每段都带转义序列，按字符串长度一刀切会把转义序列截成半截，
 * 终端上就会出现整屏乱码。正文结束后回到背景色，行尾填充才不会拖着文字色。
 */
function paintSegments(
	prefix: string,
	prefixWidth: number,
	segments: readonly ColoredSegment[],
	limit: number,
): { readonly text: string; readonly width: number } {
	let remaining = Math.max(0, limit - prefixWidth);
	let output = prefix;
	let width = prefixWidth;

	for (const segment of segments) {
		if (remaining <= 0) break;
		const visible = truncateToWidth(segment.text, remaining);
		if (visible.length === 0) continue;
		output += `${segment.color}${visible}`;
		width += displayWidth(visible);
		remaining -= displayWidth(visible);
	}
	return { text: output, width };
}
