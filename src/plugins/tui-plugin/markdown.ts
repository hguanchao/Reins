import { Lexer, type Token, type Tokens } from "marked";

import {
	concat,
	lineWidth,
	mergeStyles,
	plain,
	styled,
	type Line,
	type Span,
	type Style,
} from "../../tui/text/line.ts";
import { wrapLine } from "../../tui/text/wrap.ts";

/**
 * 把模型的回答渲染成终端行。
 *
 * 只做「块级结构 + 少量行内样式」这一层：标题、列表、代码块、引用、分隔线，行内则是粗体、
 * 斜体、行内代码与链接。表格按一串文本行处理，HTML 原样显示——它们很少出现，为此再定一套
 * 排版规则不划算。
 *
 * 解析交给 markdown 的词法分析器，只取它的记号树、不用它的输出：markdown 有正式规范与上千条
 * 边界规则，自己写必然在细节上出错；这一层要的恰好只是「记号树」这样一个稳定接缝。备选也
 * 看过：语法更底层的库等于还是自己写词法，偏重插件体系的库还得为它写一套渲染插件。这里只
 * 解析、不生成 HTML，所以不涉及转义与注入方面的问题。
 *
 * 结果里带一个「前多少行已经定型」的标记。流式输出时正文还在长，已定型的部分可以先写进
 * 滚动区不再重画，未定型的部分留在活动区里；没有这个标记就只能等整段结束才敢输出。
 */

export interface RenderedMarkdown {
	readonly lines: readonly Line[];
	/** 前多少行不会再变 */
	readonly stableLines: number;
}

/** 渲染一个块的上下文：可用宽度、首行与续行的前缀、整块叠加的样式。 */
interface Context {
	readonly width: number;
	readonly firstIndent: Line;
	readonly restIndent: Line;
	readonly base: Style | undefined;
}

const HEADING: Style = { bold: true };
const HEADING_TOP: Style = { bold: true, underline: true };
const CODE: Style = { dim: true };
const INLINE_CODE: Style = { color: "cyan" };
const LINK: Style = { underline: true };
const DIM: Style = { dim: true };

const QUOTE_PREFIX = "▏ ";
const CODE_GUTTER = "│ ";
const SEPARATOR_WIDTH = 40;

export function renderMarkdown(text: string, options: { readonly width: number }): RenderedMarkdown {
	const root: Context = {
		width: Math.max(1, options.width),
		firstIndent: [],
		restIndent: [],
		base: undefined,
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

	return { lines, stableLines };
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

function renderBlock(token: Token, context: Context): Line[] {
	switch (token.type) {
		case "heading": {
			const heading = token as Tokens.Heading;
			const style = heading.depth <= 2 ? HEADING_TOP : HEADING;
			return wrapLogical(renderInline(heading.tokens, style, context), context);
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
			return [styled("─".repeat(availableWidth(context)), DIM)];
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
	const gutter = styled(CODE_GUTTER, CODE);
	// 代码里的缩进有意义，原样保留；行尾空白没有意义，去掉
	const lines = token.text.split("\n").map((raw) => styled(raw.replace(/\s+$/, ""), CODE));
	// 竖线由换行器的前缀负责，空行也照样有，看起来才是一条连续的代码块
	return wrapLogical(lines, {
		...context,
		firstIndent: concat(context.firstIndent, gutter),
		restIndent: concat(context.restIndent, gutter),
	});
}

function renderBlockquote(token: Tokens.Blockquote, context: Context): Line[] {
	const prefix = styled(QUOTE_PREFIX, DIM);
	const inner: Context = {
		...context,
		firstIndent: concat(context.firstIndent, prefix),
		restIndent: concat(context.restIndent, prefix),
		base: mergeStyles(context.base, DIM),
	};
	return joinBlocks(token.tokens.map((child) => renderBlock(child, inner)));
}

function renderList(token: Tokens.List, context: Context): Line[] {
	const items: Line[][] = [];
	let number = token.start === "" ? 1 : Number(token.start);

	for (const item of token.items) {
		const marker = token.ordered ? `${number}. ` : "• ";
		number += 1;

		// 勾选状态由这里统一画：记号树里还带着一个勾选框记号，留着就会画两遍
		const children = item.tokens.filter((child) => child.type !== "checkbox");
		// 续行与标记对齐，列表看起来才是一栏一栏的
		const hanging = plain(" ".repeat(lineWidth([{ text: marker }])));
		const itemContext: Context = {
			...context,
			firstIndent: concat(context.firstIndent, styled(marker, DIM)),
			restIndent: concat(context.restIndent, hanging),
		};
		// 任务列表把勾选状态画出来：它表达的是「做没做」，比一个圆点有用
		const checked = item.task ? (item.checked === true ? "[x] " : "[ ] ") : "";
		const withCheck: Context =
			checked === ""
				? itemContext
				: { ...itemContext, firstIndent: concat(itemContext.firstIndent, plain(checked)) };
		// 项里的第一个块接着标记写；嵌套的列表等块与标记后的文字对齐，不再重复一遍标记
		const nested: Context = {
			...context,
			firstIndent: concat(context.firstIndent, hanging),
			restIndent: concat(context.restIndent, hanging),
		};

		items.push(
			children.length === 0
				? wrapLogical([plain(item.text)], withCheck)
				: joinBlocks(children.map((child, index) => renderBlock(child, index === 0 ? withCheck : nested))),
		);
	}

	return joinBlocks(items);
}

function renderTable(token: Tokens.Table, context: Context): Line[] {
	const cellLines = (cells: readonly Tokens.TableCell[], style: Style | undefined): readonly Line[] =>
		cells.map((cell) => renderInline(cell.tokens, style, context).flat());

	const rows: Line[] = [joinCells(cellLines(token.header, HEADING))];
	rows.push(styled("─".repeat(availableWidth(context)), DIM));
	for (const row of token.rows) rows.push(joinCells(cellLines(row, undefined)));
	return wrapLogical(rows, context);

	function joinCells(lines: readonly Line[]): Line {
		const joined: Span[] = [];
		lines.forEach((line, index) => {
			if (index > 0) joined.push(...styled(" │ ", DIM));
			joined.push(...line);
		});
		return joined;
	}
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
				builder.appendLines(
					renderInline((token as Tokens.Strong).tokens, mergeStyles(style, { bold: true }), context),
				);
				continue;
			case "em":
				builder.appendLines(
					renderInline((token as Tokens.Em).tokens, mergeStyles(style, { italic: true }), context),
				);
				continue;
			case "del":
				// 删除线在各终端表现不一，按普通文字画，内容不丢
				builder.appendLines(renderInline((token as Tokens.Del).tokens, style, context));
				continue;
			case "codespan":
				builder.append(decorate((token as Tokens.Codespan).text, mergeStyles(style, INLINE_CODE), context));
				continue;
			case "link":
				builder.appendLines(renderInline((token as Tokens.Link).tokens, mergeStyles(style, LINK), context));
				continue;
			case "image":
				builder.append(decorate(`[图片：${(token as Tokens.Image).text}]`, mergeStyles(style, DIM), context));
				continue;
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
	const merged = mergeStyles(style, context.base);
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
	return Math.max(1, Math.min(SEPARATOR_WIDTH, context.width - lineWidth(context.firstIndent)));
}

/** 取记号的原始文本。用途是「保住内容」，不追求精确还原。 */
function rawText(token: Token): string {
	const value = (token as { readonly text?: unknown }).text;
	return typeof value === "string" ? value : "";
}
