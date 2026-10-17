import { common, createLowlight } from "lowlight";
import type { Element, Root, RootContent } from "hast";
import { Lexer, type Token, type Tokens } from "marked";

import {
	concat,
	lineText,
	lineWidth,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	type Line,
	type Span,
	type Style,
} from "../../tui/text/line.ts";
import { wrapLine } from "../../tui/text/wrap.ts";
import { THEME } from "./theme.ts";

/**
 * 把模型的回答渲染成终端行。
 *
 * 块级结构：标题、列表、表格（盒线框）、围栏代码（整行底色面板）、引用与分隔线；行内则是
 * 粗体、斜体、行内代码与链接（正文后跟灰色括注地址）。表格与代码块下面还各带一行
 * 「◇ lang [Copy …]」操作行：鼠标点在方括号上就把表格的 TSV/CSV/Markdown 或代码原文写进
 * 剪贴板，可点区域随渲染结果透传给界面层。
 *
 * 解析交给 markdown 的词法分析器，只取它的记号树、不用它的输出：markdown 有正式规范与上千条
 * 边界规则，自己写必然在细节上出错；这一层要的恰好只是「记号树」这样一个稳定接缝。这里只
 * 解析、不生成 HTML，所以不涉及转义与注入方面的问题。
 *
 * 结果里带一个「前多少行已经定型」的标记。流式输出时正文还在长，已定型的部分可以先写进
 * 滚动区不再重画，未定型的部分留在活动区里；没有这个标记就只能等整段结束才敢输出。
 */

export interface CopyAffordance {
	/** 操作行在渲染结果里的行号。 */
	readonly line: number;
	/** 可点击的方括号标签在本行内的列范围，[from, to)。 */
	readonly from: number;
	readonly to: number;
	/** 点击后写进剪贴板的内容。 */
	readonly content: string;
}

export interface RenderedMarkdown {
	readonly lines: readonly Line[];
	/** 前多少行不会再变 */
	readonly stableLines: number;
	/** 块下面的操作行里可以点击复制的区域。 */
	readonly copies: readonly CopyAffordance[];
}

/** 渲染一个块的上下文：可用宽度、首行与续行的前缀、整块叠加的样式。 */
interface Context {
	readonly width: number;
	readonly firstIndent: Line;
	readonly restIndent: Line;
	readonly base: Style | undefined;
	/** 列表嵌套深度：决定子弹符。 */
	readonly listDepth: number;
	/** 渲染过程中收集到的可点击复制区域。 */
	readonly copies: CopyAffordance[];
}

const BODY: Style = { color: THEME.bright };
const STRONG: Style = { bold: true };
const EMPHASIS: Style = { italic: true };
const STRIKE: Style = { strikethrough: true };
const H1: Style = { bold: true, color: THEME.mdTeal };
const H2: Style = { bold: true, color: THEME.system };
const H3: Style = { bold: true, color: THEME.accent };
const H4: Style = { bold: true, color: THEME.grayBright };
const H5: Style = { bold: true, color: THEME.muted };
const H6: Style = { color: THEME.faint };
const INLINE_CODE: Style = { color: THEME.code, bold: true };
const LINK: Style = { color: THEME.system, underline: true };
const QUOTE: Style = { color: THEME.muted, dim: true };
const RULE: Style = { color: THEME.muted };
const TABLE_BORDER: Style = { color: THEME.muted, dim: true };
const TABLE_HEADER: Style = { bold: true };
const TASK_CHECKED: Style = { color: THEME.ok };
const TASK_UNCHECKED: Style = { color: THEME.muted, dim: true };
const MUTED: Style = { color: THEME.muted };
const FAINT: Style = { color: THEME.faint };
const CODE_TEXT: Style = { color: THEME.text, background: THEME.codeBg };

const QUOTE_PREFIX = "│ ";
/** 列表子弹符按深度取用。 */
const BULLETS = ["• ", "◦ ", "▪ "];
/** 表格单元左右各留一格空白。 */
const TABLE_PADDING = 1;

const lowlight = createLowlight(common);

/** 低亮语言名与 highlight.js 的注册名不一致时先归一。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	py: "python",
	rs: "rust",
	yml: "yaml",
	md: "markdown",
	html: "xml",
	htm: "xml",
};

/** 语法记号类别到界面样式的映射；只覆盖常见类别，认不出的按普通代码画。 */
const SYNTAX_STYLES: Readonly<Record<string, Style>> = {
	keyword: { color: THEME.accent },
	"selector-tag": { color: THEME.accent },
	built_in: { color: THEME.system },
	type: { color: THEME.teal },
	literal: { color: THEME.system },
	number: { color: THEME.path },
	string: { color: THEME.ok },
	regexp: { color: THEME.ok },
	comment: { color: THEME.muted, italic: true },
	quote: { color: THEME.muted, italic: true },
	meta: { color: THEME.muted },
	title: { color: THEME.system },
	section: { color: THEME.system },
	"selector-id": { color: THEME.system },
	attr: { color: THEME.text },
	attribute: { color: THEME.text },
	variable: { color: THEME.text },
	"template-variable": { color: THEME.path },
	symbol: { color: THEME.accent },
	bullet: { color: THEME.accent },
	link: { color: THEME.system, underline: true },
	emphasis: { italic: true },
	strong: { bold: true },
	deletion: { color: THEME.bad },
	addition: { color: THEME.ok },
};

interface CodeToken {
	readonly text: string;
	readonly style: Style | undefined;
}

function highlightLines(code: string, language: string | undefined, base: Style): Line[] {
	const resolved = language === undefined ? undefined : (LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase());
	if (resolved === undefined || resolved.length === 0 || !lowlight.registered(resolved)) {
		return code.split("\n").map((line) => styled(line, base));
	}

	const tokens: CodeToken[] = [];
	for (const child of lowlight.highlight(resolved, code).children) collectCode(child, undefined, tokens);

	const lines: Span[][] = [[]];
	for (const token of tokens) {
		const parts = token.text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part.length > 0) {
				lines[lines.length - 1].push({
					text: part,
					style: mergeStyles(base, token.style) ?? base,
				});
			}
		});
	}
	return lines;
}

function collectCode(node: Root | RootContent, inherited: Style | undefined, out: CodeToken[]): void {
	if (node.type === "text") {
		if (node.value.length > 0) out.push({ text: node.value, style: inherited });
		return;
	}
	if (node.type !== "root" && node.type !== "element") return;

	const classes = node.type === "element" ? classNameOf(node) : "";
	const style = classes.length === 0 ? inherited : (syntaxStyle(classes) ?? inherited);
	for (const child of node.children) collectCode(child, style, out);
}

function classNameOf(element: Element): string {
	const value = element.properties?.className;
	if (Array.isArray(value)) return value.join(" ");
	return typeof value === "string" ? value : "";
}

function syntaxStyle(classes: string): Style | undefined {
	for (const name of classes.split(/\s+/)) {
		if (!name.startsWith("hljs-")) continue;
		const style = SYNTAX_STYLES[name.slice(5)];
		if (style !== undefined) return style;
	}
	return undefined;
}

function headingStyle(depth: number): Style {
	switch (depth) {
		case 1:
			return H1;
		case 2:
			return H2;
		case 3:
			return H3;
		case 4:
			return H4;
		case 5:
			return H5;
		default:
			return H6;
	}
}

export function renderMarkdown(text: string, options: { readonly width: number }): RenderedMarkdown {
	const root: Context = {
		width: Math.max(1, options.width),
		firstIndent: [],
		restIndent: [],
		base: BODY,
		listDepth: 0,
		copies: [],
	};

	const tokens = Lexer.lex(text);
	const lines: Line[] = [];
	let stableLines = 0;

	tokens.forEach((token, index) => {
		// 空行只作为块之间的分隔，由渲染时统一补，不在这里产生行
		if (token.type === "space") return;

		if (lines.length > 0) lines.push([]);
		const start = lines.length;
		lines.push(...renderBlock(token, root));

		// 除最后一个记号外都已经写完，它们画出的行不会再变
		const isLast = index === tokens.length - 1;
		stableLines = isLast
			? start + stableWithinLastToken(token, lines.length - start)
			: lines.length;
	});

	return { lines, stableLines, copies: root.copies };
}

/**
 * 还没写完的那个记号里，有前几行可以立刻交出去。
 *
 * 最后一行随时可能因为多出几个字而重排，一律不算。其余的行只在两种情况下会回头改：换行
 * 位置变了，或者行内标记闭合后改变了样式。所以只有「换行是唯一变量」的内容才敢往前多交
 * 一行——代码块里的星号是字面意思，不算标记。
 */
function stableWithinLastToken(token: Token, produced: number): number {
	if (produced === 0) return 0;
	if (token.type === "code") return produced - 1;

	const raw = (token as { readonly raw?: unknown }).raw;
	if (typeof raw === "string" && !INLINE_MARKUP.test(raw)) return produced - 1;
	return 0;
}

/** 会改变行内样式的字符。 */
const INLINE_MARKUP = /[*_`[\]\\]/;

function renderBlock(token: Token, context: Context): readonly Line[] {
	switch (token.type) {
		case "heading": {
			const heading = token as Tokens.Heading;
			return wrapLogical(renderInline(heading.tokens, headingStyle(heading.depth), context), context);
		}
		case "paragraph":
			return wrapLogical(renderInline((token as Tokens.Paragraph).tokens, undefined, context), context);
		case "text": {
			const text = token as Tokens.Text;
			// 列表项里的文本往往还带着一层记号，没有就直接当纯文本画
			const inner = text.tokens === undefined ? [text] : text.tokens;
			return wrapLogical(renderInline(inner, undefined, context), context);
		}
		case "code":
			return renderCode(token as Tokens.Code, context);
		case "blockquote":
			return renderBlockquote(token as Tokens.Blockquote, context);
		case "list":
			return renderList(token as Tokens.List, context);
		case "hr":
			// 分隔线只画三格：一条短短的横线，不是贯穿整个内容区
			return [styled("───", RULE)];
		case "table":
			return renderTable(token as Tokens.Table, context);
		case "html":
			return wrapLogical([plain((token as Tokens.HTML).text)], context);
		default: {
			// 其余记号（定义、勾选框等）几乎不单独出现，取得到文本就照纯文本画，取不到就丢掉
			const text = rawText(token);
			return text.length === 0 ? [] : wrapLogical([plain(text)], context);
		}
	}
}

function renderCode(token: Tokens.Code, context: Context): Line[] {
	const codeStyle: Style = mergeStyles(context.base, CODE_TEXT) ?? CODE_TEXT;
	// 代码里的缩进有意义，原样保留；行尾空白没有意义，去掉
	const code = token.text
		.split("\n")
		.map((raw) => raw.replace(/\s+$/, ""))
		.join("\n");
	const language = token.lang?.trim().split(/\s+/)[0];
	const lines = highlightLines(code, language, codeStyle);
	// 背景铺满整行，代码块才是一整块面板；不需要竖线边框
	const wrapped = wrapLogical(lines, context);
	const panel = wrapped.map((line) => padLine(line, context.width, codeStyle));

	if (language === undefined || language.length === 0) return panel;
	pushCopyRow(context, panel, language, [{ name: "Copy", content: token.text.replace(/\s+$/, "") }]);
	return panel;
}

/**
 * 代码块/表格下面的操作行：`◇ 标签   [Copy …]`。
 *
 * 方括号标签的列范围记进渲染上下文，界面层据此做点击命中；点击行为最后写剪贴板的文字由
 * 这里一并给出。
 */
function pushCopyRow(
	context: Context,
	lines: Line[],
	label: string,
	actions: readonly { readonly name: string; readonly content: string }[],
): void {
	let row: Line = concat(styled("◇ ", FAINT), styled(label, MUTED));
	for (const action of actions) {
		const labelSpan = styled(`[${action.name}]`, MUTED);
		const from = lineWidth(row) + 3;
		const to = from + lineWidth(labelSpan);
		row = concat(row, plain("   "), labelSpan);
		context.copies.push({ line: lines.length, from, to, content: action.content });
	}
	lines.push(row);
}

function renderBlockquote(token: Tokens.Blockquote, context: Context): Line[] {
	const prefix = styled(QUOTE_PREFIX, QUOTE);
	const inner: Context = {
		...context,
		firstIndent: concat(context.firstIndent, prefix),
		restIndent: concat(context.restIndent, prefix),
		base: mergeStyles(context.base, QUOTE),
	};
	return joinBlocks(token.tokens.map((child) => renderBlock(child, inner)));
}

function renderList(token: Tokens.List, context: Context): Line[] {
	const items: Line[][] = [];
	let number = token.start === "" ? 1 : Number(token.start);
	// 子弹符按嵌套深度换字；有序列表的数字标记保持原样
	const depth = Math.min(context.listDepth, BULLETS.length - 1);

	for (const item of token.items) {
		const marker = token.ordered ? `${number}. ` : BULLETS[depth];
		number += 1;

		// 勾选状态由这里统一画：记号树里还带着一个勾选框记号，留着就会画两遍
		const children = item.tokens.filter((child) => child.type !== "checkbox");
		// 续行与标记对齐，列表看起来才是一栏一栏的
		const hanging = plain(" ".repeat(lineWidth([{ text: marker }])));
		const itemContext: Context = {
			...context,
			firstIndent: concat(context.firstIndent, styled(marker, MUTED)),
			restIndent: concat(context.restIndent, hanging),
		};
		// 任务列表把勾选状态画出来：它表达的是「做没做」，比一个圆点有用
		const checked = item.task ? (item.checked === true ? "[x] " : "[ ] ") : "";
		const withCheck: Context =
			checked === ""
				? itemContext
				: {
						...itemContext,
						firstIndent: concat(
							itemContext.firstIndent,
							styled(checked, item.checked === true ? TASK_CHECKED : TASK_UNCHECKED),
						),
					};
		// 项里的第一个块接着标记写；嵌套的列表等块与标记后的文字对齐，不再重复一遍标记
		const nested: Context = {
			...context,
			firstIndent: concat(context.firstIndent, hanging),
			restIndent: concat(context.restIndent, hanging),
			listDepth: context.listDepth + 1,
		};

		items.push(
			children.length === 0
				? wrapLogical([plain(item.text)], withCheck)
				: joinBlocks(children.map((child, index) => renderBlock(child, index === 0 ? withCheck : nested))),
		);
	}

	// 紧凑列表项之间不留空行；松散列表保留源文本里的分段
	return token.loose ? joinBlocks(items) : items.flat();
}

function renderTable(token: Tokens.Table, context: Context): readonly Line[] {
	const border = mergeStyles(context.base, TABLE_BORDER) ?? TABLE_BORDER;
	const header: Line[] = token.header.map((cell) => renderInline(cell.tokens, TABLE_HEADER, context).flat());
	const body: Line[][] = token.rows.map((row) =>
		row.map((cell) => renderInline(cell.tokens, undefined, context).flat()),
	);
	const columns = Math.max(1, token.header.length, ...token.rows.map((row) => row.length));

	// 列宽取各列内容的最宽显示宽；总宽放不下时从最宽的列开始逐列压缩
	const widths = Array.from({ length: columns }, (_, index) => {
		const cells = [header[index], ...body.map((row) => row[index])].filter(
			(cell): cell is Line => cell !== undefined,
		);
		return Math.max(1, ...cells.map((cell) => lineWidth(cell)));
	});
	const totalWidth = (): number => widths.reduce((total, width) => total + width, 0) + 3 * columns + 1;
	const available = Math.max(1, availableWidth(context));
	while (totalWidth() > available && widths.some((width) => width > 1)) {
		const widest = widths.reduce((max, width, index) => (width > widths[max] ? index : max), 0);
		widths[widest] = Math.max(1, widths[widest] - 1);
	}

	const cellLines = (cells: readonly Line[], index: number): readonly Line[] => {
		return wrapLine(cells[index] ?? [], { width: widths[index] ?? 1 });
	};

	// 记录每个单元的纯文本，操作行复制 TSV/CSV 时用
	const plainCell = (cells: readonly Line[], index: number): string => {
		return cellLines(cells, index)
			.map((line) => lineText(line).trim())
			.filter((text) => text.length > 0)
			.join(" ");
	};

	const lines: Line[] = [joinBorder("┌", "┬", "┐")];
	lines.push(...rowOf(header, true));
	lines.push(joinBorder("├", "┼", "┤"));
	token.rows.forEach((_, index) => {
		lines.push(...rowOf(body[index] ?? [], false));
		if (index < token.rows.length - 1) lines.push(joinBorder("├", "┼", "┤"));
	});
	lines.push(joinBorder("└", "┴", "┘"));

	// 表格下面再给一行复制操作：TSV 给表格软件，CSV 给报表，Markdown 保源文本
	const matrix = [header, ...body];
	pushCopyRow(context, lines, "table", [
		{
			name: "Copy TSV",
			content: matrix
				.map((cells) => cells.map((_, index) => plainCell(cells, index)).join("\t"))
				.join("\n"),
		},
		{
			name: "Copy CSV",
			content: matrix
				.map((cells) => cells.map((_, index) => csvCell(plainCell(cells, index))).join(","))
				.join("\n"),
		},
		{ name: "Copy Markdown", content: tableSource(token) },
	]);

	return lines;

	function rowOf(cells: readonly Line[], isHeader: boolean): readonly Line[] {
		const wrapped = Array.from({ length: columns }, (_, index) => cellLines(cells, index));
		const height = Math.max(1, ...wrapped.map((lines) => lines.length));
		const rows: Line[] = [];
		for (let line = 0; line < height; line += 1) {
			const row: Span[] = [];
			for (let index = 0; index < columns; index += 1) {
				const width = widths[index] ?? 1;
				const source = wrapped[index]?.[line];
				const content = source === undefined ? [] : alignCell(source, width, index);
				row.push(...styled(`│${" ".repeat(TABLE_PADDING)}`, border));
				if (isHeader) {
					row.push(
						...padLine(mapLine(content, (style) => mergeStyles(style, { bold: true }) ?? { bold: true }), width),
					);
				} else {
					row.push(...padLine(content, width));
				}
				row.push(...styled(`${" ".repeat(TABLE_PADDING)}│`, border));
			}
			rows.push(row);
		}
		return rows;
	}

	function joinBorder(left: string, joint: string, right: string): Line {
		let parts: Line = styled(left, border);
		widths.forEach((width, index) => {
			parts = index > 0 ? concat(parts, styled(joint, border)) : parts;
			parts = concat(parts, styled("─".repeat(width + TABLE_PADDING * 2), border));
		});
		return concat(parts, styled(right, border));
	}

	function alignCell(line: Line, width: number, index: number): Line {
		const gap = width - lineWidth(line);
		if (gap <= 0) return line;

		switch (token.align[index] ?? null) {
			case "right":
				return concat(plain(" ".repeat(gap)), line);
			case "center": {
				const left = Math.floor(gap / 2);
				return concat(plain(" ".repeat(left)), line, plain(" ".repeat(gap - left)));
			}
			default:
				return concat(line, plain(" ".repeat(gap)));
		}
	}
}

/** 表格的源文本：[Copy Markdown] 用它原样复制回去。 */
function tableSource(token: Tokens.Table): string {
	const raw = (token as { readonly raw?: unknown }).raw;
	return typeof raw === "string" ? raw.trimEnd() : "";
}

/** CSV 单元格：带逗号、引号或换行的内容用引号包住，内部引号翻倍。 */
function csvCell(text: string): string {
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 行内记号画成若干逻辑行（硬换行会断开），样式逐层叠加。 */
function renderInline(tokens: readonly Token[], style: Style | undefined, context: Context): Line[] {
	const builder = new InlineBuilder();

	for (const token of tokens) {
		switch (token.type) {
			case "text": {
				const text = token as Tokens.Text;
				if (text.tokens === undefined) builder.append(decorate(text.text, style, context));
				else builder.appendLines(renderInline(text.tokens, style, context));
				continue;
			}
			case "escape":
				builder.append(decorate((token as Tokens.Escape).text, style, context));
				continue;
			case "strong":
				builder.appendLines(renderInline((token as Tokens.Strong).tokens, mergeStyles(style, STRONG), context));
				continue;
			case "em":
				builder.appendLines(renderInline((token as Tokens.Em).tokens, mergeStyles(style, EMPHASIS), context));
				continue;
			case "del":
				builder.appendLines(renderInline((token as Tokens.Del).tokens, mergeStyles(style, STRIKE), context));
				continue;
			case "codespan":
				builder.append(decorate((token as Tokens.Codespan).text, mergeStyles(style, INLINE_CODE), context));
				continue;
			case "link": {
				const link = token as Tokens.Link;
				const withLink = mergeStyles(
					mergeStyles(style, LINK),
					link.href.length > 0 ? { link: link.href } : undefined,
				);
				builder.appendLines(renderInline(link.tokens, withLink, context));
				// 链接文字后面用暗色把地址括注出来，终端里点不着也知道跳去哪
				if (link.href.length > 0) builder.append(decorate(` (${link.href})`, MUTED, context));
				continue;
			}
			case "image": {
				const image = token as Tokens.Image;
				const withLink = mergeStyles(
					mergeStyles(style, MUTED),
					image.href.length > 0 ? { link: image.href } : undefined,
				);
				builder.append(decorate(`[image: ${image.text}]`, withLink, context));
				continue;
			}
			case "br":
				builder.break();
				continue;
			default:
				builder.append(decorate(rawText(token), style, context));
				continue;
		}
	}

	return builder.lines;
}

/** 逐段追加行内内容，遇到硬换行就另起一行。 */
class InlineBuilder {
	readonly lines: Span[][] = [[]];

	append(line: Line): void {
		this.lines[this.lines.length - 1].push(...line);
	}

	appendLines(lines: readonly Line[]): void {
		lines.forEach((line, index) => {
			if (index === 0) this.append(line);
			else this.lines.push([...line]);
		});
	}

	break(): void {
		this.lines.push([]);
	}
}

function decorate(text: string, style: Style | undefined, context: Context): Line {
	const merged = mergeStyles(context.base, style);
	return merged === undefined ? plain(text) : styled(text, merged);
}

/** 把逻辑行按可用宽度折开：第一行用首行前缀，其余用续行前缀。 */
function wrapLogical(logical: readonly Line[], context: Context): Line[] {
	const lines: Line[] = [];
	logical.forEach((line, index) => {
		lines.push(
			...wrapLine(line, {
				width: context.width,
				firstIndent: index === 0 ? context.firstIndent : context.restIndent,
				restIndent: context.restIndent,
			}),
		);
	});
	return lines;
}

/** 块与块之间空一行，隔着一条横线或一段代码读起来才有层次。 */
function joinBlocks(blocks: readonly (readonly Line[])[]): Line[] {
	const lines: Line[] = [];
	for (const block of blocks) {
		if (lines.length > 0) lines.push([]);
		lines.push(...block);
	}
	return lines;
}

/** 去掉缩进之后还剩多少列可用。 */
function availableWidth(context: Context): number {
	return Math.max(1, context.width - lineWidth(context.firstIndent));
}

/** 取记号的原始文本。用途是「保住内容」，不追求精确还原。 */
function rawText(token: Token): string {
	const value = (token as { readonly text?: unknown }).text;
	return typeof value === "string" ? value : "";
}
