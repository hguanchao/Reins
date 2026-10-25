import { lexer, type Token, type Tokens } from "marked";

import { sanitizeDetail, sanitizeLine } from "../../tools/describe.ts";
import { highlightCode, type SyntaxLines } from "../../tools/syntax.ts";
import { syntaxColor } from "./syntax-style.ts";
import { characterWidth, displayWidth, fitToWidth, truncateToWidth } from "./text.ts";
import { THEME } from "./theme.ts";

/**
 * 助手回复的 Markdown 排版。
 *
 * 只负责把 Markdown 变成终端行：每个块自己管理缩进与空行，最后统一补齐到内容区宽度。
 * 用户提示、思考正文和工具结果不是 Markdown，不经过这里。
 */

const RESET = THEME.reset;
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";
const UNDERLINE = "\x1b[4m";
const BODY = THEME.textPrimary;
const MARKER = THEME.textSubtle;
const BORDER = THEME.border;
/** 代码块色带：比浮起表面再弱一档，内容仍然是视觉主体。 */
const CODE_BG = THEME.codeBg;
/** 六级标题各自的颜色；H1–H5 加粗，H6 不加粗。 */
const HEADING_STYLES = [
	`${BOLD}${THEME.accent}`,
	`${BOLD}${THEME.path}`,
	`${BOLD}${THEME.syntaxKeyword}`,
	`${BOLD}${THEME.textSecondary}`,
	`${BOLD}${THEME.textSubtle}`,
	THEME.textDisabled,
] as const;
const LINK = `${UNDERLINE}${THEME.path}`;
const HTML_TAG = THEME.syntaxType;
/** 正文左边距，与普通回复的缩进一致。 */
const INDENT = 2;
/** 代码块色带左侧留白、带内左内边距与右侧内边距。 */
const CODE_PADDING = 1;
const RIGHT_PADDING = 1;
/** 表格列的最小宽度。 */
const MIN_COLUMN = 3;

interface Span {
	readonly text: string;
	readonly style: string;
	/** OSC 8 的目标；没有链接时不加 */
	readonly link?: string;
}

/** 屏幕行：spans 已经包含左侧缩进，fill 是行尾补齐样式（色带需要）。 */
interface Row {
	readonly spans: readonly Span[];
	readonly fill?: string;
}

type Atom = Span | { readonly br: true };

interface Context {
	/** 内容区宽度（已扣掉滚动条列） */
	readonly width: number;
	/** 当前块左侧缩进列数 */
	readonly indent: number;
}

/** Markdown 代码围栏的语言名到扩展名；认不出的语言退回纯文本。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	shell: "bash",
	console: "bash",
	typescript: "ts",
	javascript: "js",
	python: "py",
	ruby: "rb",
	rust: "rs",
	golang: "go",
	csharp: "cs",
	"c++": "cpp",
	"c#": "cs",
	jsonc: "json",
	patch: "diff",
};

export function renderMarkdown(text: string, width: number): readonly string[] {
	if (width <= 0 || text.length === 0) return [];

	// 模型输出什么都能进来，解析器对畸形输入抛错不该把整帧渲染带崩——终端会停在
	// 备用屏与原始模式里。渲染不出来就按普通正文折行，内容一行不丢
	let tokens: Token[];
	try {
		tokens = lexer(text, { gfm: true });
	} catch {
		return text.split("\n").map((line) => line);
	}
	const rows: Row[] = [];
	for (const token of tokens) appendBlock(token, { width, indent: INDENT }, rows, true);
	trimBlankEdges(rows);
	return rows.map((row) => paintRow(row, width));
}

function appendBlock(token: Token, context: Context, rows: Row[], spaced: boolean): void {
	switch (token.type) {
		case "space":
		case "def":
			return;
		case "heading":
			pushGap(rows, spaced);
			pushWrapped(rows, inlineAtoms(token.tokens, headingStyle(token.depth)), context.width, spaces(context.indent));
			return;
		case "paragraph":
		case "text":
			pushGap(rows, spaced);
			pushWrapped(rows, inlineAtoms(token.tokens, BODY), context.width, spaces(context.indent));
			return;
		case "list":
			pushGap(rows, spaced);
			appendList(token as Tokens.List, context, rows);
			return;
		case "blockquote":
			pushGap(rows, spaced);
			appendQuote(token as Tokens.Blockquote, context, rows);
			return;
		case "code":
			pushGap(rows, spaced);
			appendCode(token as Tokens.Code, context, rows);
			return;
		case "hr":
			pushGap(rows, spaced);
			rows.push({
				spans: [
					...spaces(context.indent),
					{ text: "─".repeat(Math.max(0, context.width - context.indent)), style: BORDER },
				],
			});
			return;
		case "table":
			pushGap(rows, spaced);
			appendTable(token as Tokens.Table, context, rows);
			return;
		case "html":
			pushGap(rows, spaced);
			appendHtml(token as Tokens.HTML, context, rows);
			return;
		default:
			pushGap(rows, spaced);
			appendFallback(token, context, rows);
	}
}

function appendList(token: Tokens.List, context: Context, rows: Row[]): void {
	const start = typeof token.start === "number" ? token.start : 1;
	for (const [index, item] of token.items.entries()) {
		if (token.loose && index > 0) pushGap(rows, true);
		appendListItem(item, token.ordered ? start + index : undefined, context, rows, token.loose);
	}
}

/**
 * 列表项。
 *
 * 第一段与标记同一行，续行缩进到标记之后；嵌套列表、代码块等后续块对齐到正文列。
 */
function appendListItem(
	item: Tokens.ListItem,
	number: number | undefined,
	context: Context,
	rows: Row[],
	loose: boolean,
): void {
	const marker = item.task ? `${item.checked === true ? "[x]" : "[ ]"} ` : number === undefined ? "• " : `${number}. `;
	const contentIndent = context.indent + displayWidth(marker);
	// 任务项的复选框已经由 marker 表示，跳过 token，否则会多出一行孤立的 [x]
	const blocks = item.tokens.filter((token, index) => !(index === 0 && token.type === "checkbox"));
	let first = true;

	for (const token of blocks) {
		if (first && (token.type === "paragraph" || token.type === "text")) {
			pushWrapped(
				rows,
				inlineAtoms(token.tokens, BODY),
				context.width,
				prefix(context.indent, marker),
				spaces(contentIndent),
			);
			first = false;
			continue;
		}
		if (first) {
			rows.push({ spans: prefix(context.indent, marker) });
			first = false;
		}
		if (loose) pushGap(rows, true);
		appendBlock(token, { width: context.width, indent: contentIndent }, rows, false);
	}

	if (first) rows.push({ spans: prefix(context.indent, marker) });
}

function appendQuote(token: Tokens.Blockquote, context: Context, rows: Row[]): void {
	const inner: Row[] = [];
	for (const child of token.tokens) {
		appendBlock(child, { width: context.width, indent: context.indent + 2 }, inner, true);
	}
	for (const row of inner) rows.push(withBar(row, context.indent));
}

/** 把引用内容左侧缩进换成竖线；色带行也照样带线。 */
function withBar(row: Row, indent: number): Row {
	const spans = [...row.spans];
	const first = spans[0];
	const remove = indent + 2;
	if (first !== undefined && first.text.length >= remove && first.text.slice(0, remove).trim().length === 0) {
		spans[0] = { ...first, text: first.text.slice(remove) };
	}
	return {
		spans: [{ text: " ".repeat(indent), style: BODY }, { text: "│ ", style: BORDER }, ...spans],
		...(row.fill === undefined ? {} : { fill: row.fill }),
	};
}

function appendCode(token: Tokens.Code, context: Context, rows: Row[]): void {
	const source = sanitizeDetail(token.text.replace(/\n$/, ""));
	const codeLines = source.split("\n");
	const highlighted = highlightFence(source, token.lang);
	const bandStart = Math.min(context.indent, context.width);
	const innerWidth = Math.max(1, context.width - bandStart - CODE_PADDING - RIGHT_PADDING);

	rows.push({ spans: spaces(bandStart), fill: CODE_BG });
	for (const [index, line] of codeLines.entries()) {
		const spans: Span[] = [...spaces(bandStart), { text: " ".repeat(CODE_PADDING), style: CODE_BG }];
		const segments = highlighted?.[index];
		if (segments === undefined) {
			spans.push({ text: truncateToWidth(line, innerWidth), style: `${CODE_BG}${BODY}` });
		} else {
			for (const segment of segments) {
				spans.push({ text: truncateToWidth(segment.text, innerWidth), style: `${CODE_BG}${syntaxColor(segment.token)}` });
			}
		}
		rows.push({ spans, fill: CODE_BG });
	}
	rows.push({ spans: spaces(bandStart), fill: CODE_BG });
}

function appendTable(token: Tokens.Table, context: Context, rows: Row[]): void {
	const columns = token.header.length;
	if (columns === 0) return;

	const header = token.header.map((cell) => plainInline(cell.tokens));
	const body = token.rows.map((row) => row.map((cell) => plainInline(cell.tokens)));
	const widths = columnWidths([header, ...body], columns, context.width - context.indent);

	rows.push(tableBorder("┌", "┬", "┐", widths, context));
	pushTableRows(rows, context, header, widths, token.align, `${BOLD}${BODY}`);
	rows.push(tableBorder("├", "┼", "┤", widths, context));
	for (const [index, row] of body.entries()) {
		if (index > 0) rows.push(tableBorder("├", "┼", "┤", widths, context));
		pushTableRows(rows, context, row, widths, token.align, BODY);
	}
	rows.push(tableBorder("└", "┴", "┘", widths, context));
}

function tableBorder(
	left: string,
	middle: string,
	right: string,
	widths: readonly number[],
	context: Context,
): Row {
	return {
		spans: [
			...spaces(context.indent),
			{
				text: left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right,
				style: BORDER,
			},
		],
	};
}

/** 表格行可能有多行：单元格按列宽折行，整行按最高的单元格补齐。 */
function pushTableRows(
	rows: Row[],
	context: Context,
	cells: readonly string[],
	widths: readonly number[],
	align: readonly (Tokens.Table["align"][number])[],
	style: string,
): void {
	const wrapped = cells.map((cell, index) => wrapPlainWords(cell, widths[index] ?? 1));
	const height = Math.max(1, ...wrapped.map((lines) => lines.length));

	for (let line = 0; line < height; line += 1) {
		const spans: Span[] = [...spaces(context.indent)];
		for (const [column, width] of widths.entries()) {
			spans.push({ text: "│ ", style: BORDER });
			spans.push({ text: padCell(wrapped[column]?.[line] ?? "", width, align[column] ?? null), style });
			spans.push({ text: " ", style: BORDER });
		}
		spans.push({ text: "│", style: BORDER });
		rows.push({ spans });
	}
}

/** 列宽按内容取最大值；终端太窄时优先压缩最宽的列，最少留 MIN_COLUMN 列。 */
function columnWidths(rows: readonly (readonly string[])[], columns: number, available: number): number[] {
	const widths = Array.from({ length: columns }, (_, index) =>
		Math.max(MIN_COLUMN, ...rows.map((row) => displayWidth(row[index] ?? ""))),
	);
	// 每列左右各 1 格留白和 1 根边线，末尾再加一根右边线
	const overhead = columns * 3 + 1;
	const budget = Math.max(columns, available - overhead);
	const total = (): number => widths.reduce((sum, width) => sum + width, 0);

	while (total() > budget) {
		let widest = 0;
		for (let index = 1; index < widths.length; index += 1) {
			if ((widths[index] ?? 0) > (widths[widest] ?? 0)) widest = index;
		}
		if ((widths[widest] ?? 0) <= MIN_COLUMN) break;
		widths[widest] = (widths[widest] ?? MIN_COLUMN) - 1;
	}
	return widths;
}

/** 按单词折行；CJK 与超长单词没有空格，按字符断开。 */
function wrapPlainWords(text: string, limit: number): string[] {
	const width = Math.max(1, limit);
	const lines: string[] = [];
	let line = "";
	let used = 0;

	for (const char of text) {
		const charWidth = characterWidth(char);
		if (used + charWidth > width && used > 0) {
			const space = line.lastIndexOf(" ");
			if (space > 0) {
				const carry = line.slice(space + 1);
				lines.push(line.slice(0, space));
				line = carry;
				used = displayWidth(carry);
			} else {
				lines.push(line);
				line = "";
				used = 0;
			}
		}
		line += char;
		used += charWidth;
	}
	lines.push(line);
	return lines;
}

function padCell(text: string, width: number, align: "left" | "right" | "center" | null): string {
	const visible = fitToWidth(text, width);
	const padding = Math.max(0, width - displayWidth(visible));
	if (align === "right") return `${" ".repeat(padding)}${visible}`;
	if (align === "center") {
		const left = Math.floor(padding / 2);
		return `${" ".repeat(left)}${visible}${" ".repeat(padding - left)}`;
	}
	return `${visible}${" ".repeat(padding)}`;
}

function appendHtml(token: Tokens.HTML, context: Context, rows: Row[]): void {
	const text = sanitizeDetail(token.text);
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		pushWrapped(rows, htmlAtoms(line, BODY), context.width, spaces(context.indent));
	}
}

/** 保留 HTML 标签并提亮标签本身，标签外的文字用正文色。 */
function htmlAtoms(line: string, base: string): Atom[] {
	const atoms: Atom[] = [];
	let buffer = "";
	let inTag = false;
	const flush = (style: string): void => {
		for (const char of buffer) atoms.push({ text: char, style });
		buffer = "";
	};

	for (const char of line) {
		if (inTag) {
			buffer += char;
			if (char === ">") {
				flush(`${base}${HTML_TAG}`);
				inTag = false;
			}
			continue;
		}
		if (char === "<") {
			flush(base);
			inTag = true;
			buffer = "<";
			continue;
		}
		buffer += char;
	}
	flush(inTag ? `${base}${HTML_TAG}` : base);
	return atoms;
}

function appendFallback(token: Token, context: Context, rows: Row[]): void {
	const raw = typeof (token as { readonly raw?: unknown }).raw === "string" ? (token as { readonly raw: string }).raw : "";
	const text = sanitizeLine(raw);
	if (text.length === 0) return;
	pushWrapped(rows, [{ text, style: BODY }], context.width, spaces(context.indent));
}

function headingStyle(depth: number): string {
	const index = Math.min(Math.max(1, depth), HEADING_STYLES.length) - 1;
	return HEADING_STYLES[index] ?? HEADING_STYLES[0];
}

function highlightFence(source: string, lang: string | undefined): SyntaxLines | undefined {
	if (lang === undefined) return undefined;
	const id = (lang.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
	const extension = LANGUAGE_ALIASES[id] ?? id;
	if (extension.length === 0) return undefined;
	return highlightCode(source, `snippet.${extension}`);
}

/**
 * 行内 token 展开成带样式的片段。
 *
 * 样式是「完整前缀」：每段都从当前段落的基础样式继续叠加，渲染时每段前会重置，
 * 因此粗体、链接、行内代码可以任意嵌套而不会相互串色。
 */
function inlineAtoms(tokens: readonly Token[] | undefined, base: string): Atom[] {
	const atoms: Atom[] = [];
	for (const token of tokens ?? []) {
		switch (token.type) {
			case "strong":
				atoms.push(...inlineAtoms(token.tokens, `${base}${BOLD}`));
				break;
			case "em":
				atoms.push(...inlineAtoms(token.tokens, `${base}${ITALIC}`));
				break;
			case "del":
				atoms.push(...inlineAtoms(token.tokens, `${base}${STRIKE}`));
				break;
			case "codespan":
				atoms.push({ text: sanitizeLine(token.text), style: `${base}${BOLD}${THEME.path}` });
				break;
			case "link": {
				const href = safeHref(token.href);
				for (const atom of inlineAtoms(token.tokens, `${base}${LINK}`)) {
					atoms.push(isBreak(atom) || href === undefined ? atom : { ...atom, link: href });
				}
				// 地址显示在括号里；只有链接文字挂 OSC 8，地址是弱化文字
				const url = sanitizeLine(token.href);
				if (url.length > 0 && token.raw.trimStart().startsWith("[")) {
					atoms.push({ text: ` (${url})`, style: `${base}${THEME.textSubtle}` });
				}
				break;
			}
			case "image": {
				const alt = sanitizeLine(token.text);
				const url = sanitizeLine(token.href);
				atoms.push({ text: `[image${alt.length > 0 ? `: ${alt}` : ""}]`, style: `${base}${THEME.path}` });
				atoms.push({ text: `(${url})`, style: `${base}${THEME.textSubtle}` });
				break;
			}
			case "br":
				atoms.push({ br: true });
				break;
			case "checkbox":
				atoms.push({ text: token.checked ? "[x] " : "[ ] ", style: base });
				break;
			case "html": {
				if (/^<br\s*\/?>$/i.test(token.text.trim())) {
					atoms.push({ br: true });
					break;
				}
				const tag = sanitizeLine(token.text);
				if (tag.length > 0) atoms.push({ text: tag, style: `${base}${HTML_TAG}` });
				break;
			}
			case "escape":
				atoms.push({ text: sanitizeLine(token.text), style: base });
				break;
			case "text":
				if (token.tokens !== undefined && token.tokens.length > 0) {
					atoms.push(...inlineAtoms(token.tokens, base));
				} else {
					atoms.push({ text: sanitizeLine(token.text), style: base });
				}
				break;
			default:
				if ("tokens" in token && Array.isArray(token.tokens)) {
					atoms.push(...inlineAtoms(token.tokens, base));
				} else if (typeof (token as { readonly text?: unknown }).text === "string") {
					atoms.push({ text: sanitizeLine((token as { readonly text: string }).text), style: base });
				}
		}
	}
	return atoms;
}

/** 表格单元格只保留文字：列宽与对齐按纯文本计算，样式只给表头加粗。 */
function plainInline(tokens: readonly Token[] | undefined): string {
	return inlineAtoms(tokens, "")
		.map((atom) => (isBreak(atom) ? " " : atom.text))
		.join("")
		.trim();
}

function pushWrapped(
	rows: Row[],
	atoms: readonly Atom[],
	width: number,
	firstPrefix: readonly Span[],
	restPrefix: readonly Span[] = firstPrefix,
): void {
	const limit = Math.max(0, width - displayWidth(spansText(firstPrefix)));
	const segments: Atom[][] = [[]];
	for (const atom of atoms) {
		if (isBreak(atom)) segments.push([]);
		else segments[segments.length - 1]?.push(atom);
	}

	for (const segment of segments) {
		const wrapped = wrapAtoms(segment, limit);
		for (const [index, line] of wrapped.entries()) {
			rows.push({ spans: [...(index === 0 ? firstPrefix : restPrefix), ...line] });
		}
	}
}

function wrapAtoms(atoms: readonly Atom[], limit: number): Span[][] {
	const rows: Span[][] = [[]];
	let used = 0;

	for (const atom of atoms) {
		if (isBreak(atom)) {
			rows.push([]);
			used = 0;
			continue;
		}
		for (const char of atom.text) {
			const width = characterWidth(char);
			if (used + width > limit && used > 0) {
				const current = rows[rows.length - 1] ?? [];
				// 先尝试在最近的空格处断行；没有空格或接回去放不下时按字符硬断
				let space = -1;
				for (let index = current.length - 1; index >= 0; index -= 1) {
					if (current[index]?.text === " ") {
						space = index;
						break;
					}
				}
				if (space > 0) {
					const carry = current.slice(space + 1);
					const carryWidth = carry.reduce((sum, item) => sum + characterWidth(item.text), 0);
					if (carryWidth + width <= limit) {
						current.length = space;
						rows.push(carry);
						used = carryWidth;
					} else {
						rows.push([]);
						used = 0;
					}
				} else {
					rows.push([]);
					used = 0;
				}
			}
			rows[rows.length - 1]?.push(
				atom.link === undefined ? { text: char, style: atom.style } : { text: char, style: atom.style, link: atom.link },
			);
			used += width;
		}
	}
	return rows;
}

function isBreak(atom: Atom): atom is { readonly br: true } {
	return "br" in atom;
}

function prefix(indent: number, marker: string): Span[] {
	return [{ text: " ".repeat(indent), style: BODY }, { text: marker, style: MARKER }];
}

function spaces(count: number): Span[] {
	return [{ text: " ".repeat(Math.max(0, count)), style: BODY }];
}

function spansText(spans: readonly Span[]): string {
	return spans.map((span) => span.text).join("");
}

/** 色带行不算空行：它的底色本身就是内容的一部分，不能被下一步的空行判断吞掉。 */
function isBlankRow(row: Row): boolean {
	if (row.fill !== undefined) return false;
	return row.spans.every((span) => span.text.trim().length === 0);
}

function pushGap(rows: Row[], spaced: boolean): void {
	if (!spaced || rows.length === 0) return;
	if (isBlankRow(rows[rows.length - 1] ?? { spans: [] })) return;
	rows.push({ spans: [] });
}

function trimBlankEdges(rows: Row[]): void {
	while (rows.length > 0 && isBlankRow(rows[0] ?? { spans: [] })) rows.shift();
	while (rows.length > 0 && isBlankRow(rows[rows.length - 1] ?? { spans: [] })) rows.pop();
}

function paintRow(row: Row, width: number): string {
	let output = "";
	let used = 0;

	for (const span of row.spans) {
		const text = truncateToWidth(span.text, Math.max(0, width - used));
		if (text.length === 0) continue;
		output += `${RESET}${span.style}`;
		if (span.link !== undefined) output += `\x1b]8;;${span.link}\x1b\\`;
		output += text;
		if (span.link !== undefined) output += "\x1b]8;;\x1b\\";
		used += displayWidth(text);
	}

	const padding = Math.max(0, width - used);
	if (row.fill === undefined) return `${output}${RESET}${" ".repeat(padding)}`;
	return `${output}${RESET}${row.fill}${" ".repeat(padding)}${RESET}`;
}

function safeHref(href: string): string | undefined {
	const value = href.trim();
	if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return undefined;
	if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
	return value;
}
