import {
	concat,
	mergeStyles,
	padLine,
	plain,
	styled,
	truncateLine,
	type Line,
	type Span,
	type Style,
} from "../../tui/index.ts";
import { pasteLineCount } from "../../tui/input/paste.ts";
import { OUTER_PAD } from "./layout.ts";
import type { FileEntry } from "./file-search.ts";
import type { SlashCommand } from "./slash-menu.ts";
import { ACCENT, BAND, BRIGHT, DIM, EDGE, MENU_HOVER, PATH, SELECT_BG, SYSTEM, TEXT, TITLE } from "./theme.ts";

/**
 * 输入框上方的候选面板。
 *
 * 命令与文件共用同一套版式：先一条横贯面板的框线（右侧嵌结果计数），下面是候选行，收尾再
 * 一条框线。候选行整行铺底，被选中的一行亮一档并带 ❯ 前缀；文件目录带尾斜杠并用强调色。
 * 色带只属于候选行，止步于框线——框线压在屏幕底色上，面板才像一块浮起来的浅色区。
 * 面板整体缩进会话区外边距，候选内容再比框线缩进两列。
 */

export const MAX_MENU_ROWS = 8;

/** 框线占了候选区上方的行数：屏幕行号换算候选行号时要扣掉它。 */
export const MENU_CHROME_ROWS = 1;

/** 描述列的上限：标签超过它就让位，描述列按最宽标签对齐。 */
const LABEL_CAP = 40;

export interface MenuLayout {
	readonly rows: readonly Line[];
	/** 第一行对应候选项数组里的下标。 */
	readonly top: number;
	readonly visible: number;
}

export function slashMenuRows(
	items: readonly SlashCommand[],
	selected: number,
	width: number,
	limit: number,
	query = "",
	hover?: number,
): MenuLayout {
	const window = menuWindow(items.length, selected, limit);
	if (window.visible === 0) return { rows: [], top: 0, visible: 0 };

	const panel = panelWidth(width);
	const visible = items.slice(window.top, window.top + window.visible);
	const labelWidth = Math.min(
		LABEL_CAP,
		Math.max(...visible.map((item) => item.name.length + 1 + slashTag(item).length)),
	);
	const rows = visible.map((item, offset) => {
		const index = window.top + offset;
		const active = index === selected;
		const hovered = !active && index === hover;
		const background = active ? SELECT_BG : hovered ? MENU_HOVER : BAND;
		const label = `/${item.name}`;
		const tag = slashTag(item);
		const gap = Math.max(2, labelWidth - label.length - tag.length + 2);
		// 查询只作用于命令名；前缀的斜杠不在匹配范围内，所以列号要右移一格
		const matches = fuzzyMatchIndices(item.name, query).map((index) => index + 1);
		const content = concat(
			styled(active ? "❯ " : "  ", mergeStyles(active ? TITLE : undefined, background) ?? background),
			highlighted(label, matches, active ? TITLE : ACCENT, background),
			tag.length === 0 ? plain("") : styled(tag, mergeStyles(SYSTEM, background) ?? background),
			styled(" ".repeat(gap), background),
			styled(item.description, mergeStyles(active || hovered ? BRIGHT : DIM, background) ?? background),
		);
		return itemRow(content, panel, background);
	});
	return {
		rows: withPanelChrome(rows, panel, `${items.length}`),
		top: window.top,
		visible: rows.length,
	};
}

export function fileMenuRows(
	items: readonly FileEntry[],
	selected: number,
	width: number,
	limit: number,
	hint?: string,
	query = "",
	hover?: number,
): MenuLayout {
	const window = menuWindow(items.length, selected, limit);
	if (window.visible === 0) return { rows: [], top: 0, visible: 0 };

	const panel = panelWidth(width);
	const rows = items.slice(window.top, window.top + window.visible).map((item, offset) => {
		const index = window.top + offset;
		const active = index === selected;
		const hovered = !active && index === hover;
		const background = active ? SELECT_BG : hovered ? MENU_HOVER : BAND;
		const color = active ? TITLE : item.kind === "directory" ? ACCENT : PATH;
		const path = item.kind === "directory" ? `${item.path}/` : item.path;
		// 查询匹配的是路径本身；@ 是单独的一段，不参与着色
		const matches = fuzzyMatchIndices(item.path, query);
		const content = concat(
			styled(active ? "❯ " : "  ", mergeStyles(active ? TITLE : undefined, background) ?? background),
			styled("@", mergeStyles(DIM, background) ?? background),
			highlighted(path, matches, color, background),
		);
		return itemRow(content, panel, background);
	});
	return { rows: withPanelChrome(rows, panel, hint), top: window.top, visible: rows.length };
}

/** 历史面板：最近提交的在前，多行消息只显示首行与行数。 */
export function historyMenuRows(
	entries: readonly string[],
	selected: number,
	width: number,
	limit: number,
	hover?: number,
): MenuLayout {
	const window = menuWindow(entries.length, selected, limit);
	if (window.visible === 0) return { rows: [], top: 0, visible: 0 };

	const panel = panelWidth(width);
	const rows = entries.slice(window.top, window.top + window.visible).map((text, offset) => {
		const index = window.top + offset;
		const active = index === selected;
		const hovered = !active && index === hover;
		const background = active ? SELECT_BG : hovered ? MENU_HOVER : BAND;
		const first = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
		const total = pasteLineCount(text);
		const suffix = total > 1 ? ` (+${total - 1} line${total - 1 === 1 ? "" : "s"})` : "";
		const content = concat(
			styled(active ? "❯ " : "  ", mergeStyles(active ? TITLE : undefined, background) ?? background),
			styled(first, mergeStyles(active ? TITLE : TEXT, background) ?? background),
			styled(suffix, mergeStyles(DIM, background) ?? background),
		);
		return itemRow(content, panel, background);
	});
	return { rows: withPanelChrome(rows, panel, entries.length.toString()), top: window.top, visible: rows.length };
}

/** 子序列命中的字符下标；查询为空或匹配不上时返回空数组。 */
export function fuzzyMatchIndices(text: string, query: string): readonly number[] {
	if (query.length === 0) return [];
	const haystack = text.toLowerCase();
	const indices: number[] = [];
	let cursor = 0;
	for (const char of query.toLowerCase()) {
		const found = haystack.indexOf(char, cursor);
		if (found < 0) return [];
		indices.push(found);
		cursor = found + 1;
	}
	return indices;
}

/** 把命中的字符染成系统蓝；其余部分用候选行本来的颜色。 */
function highlighted(text: string, indices: readonly number[], base: Style, background: Style): Line {
	if (indices.length === 0) {
		return styled(text, mergeStyles(base, background) ?? background);
	}
	const matched = new Set(indices);
	const spans: Span[] = [];
	let start = 0;
	for (let index = 0; index <= text.length; index += 1) {
		const isMatch = matched.has(index);
		const wasMatch = index > 0 && matched.has(index - 1);
		if (index === text.length || isMatch !== wasMatch) {
			if (index > start) {
				const style = wasMatch
					? mergeStyles({ ...base, color: SYSTEM.color, bold: true }, background)
					: mergeStyles(base, background);
				spans.push({ text: text.slice(start, index), ...(style === undefined ? {} : { style }) });
			}
			start = index;
		}
	}
	return spans;
}

/** 命令来源标记：自带命令与插件命令各自一个短标签。 */
function slashTag(item: SlashCommand): string {
	return item.tag === undefined ? "" : ` [${item.tag}]`;
}

/** 面板内部可用的宽度：扣掉两侧外边距。 */
function panelWidth(width: number): number {
	return Math.max(1, width - OUTER_PAD * 2);
}

/** 一行候选：前缀两列就是与框线的距离，不再额外缩进。 */
function itemRow(content: Line, panel: number, background: Style): Line {
	const line = truncateLine(content, panel);
	return padLine(line, panel, background);
}

/**
 * 面板框线：上下两条横线，右上角嵌结果计数；整个面板缩进外边距。
 *
 * 框线行不写背景——候选行的色带不覆盖到框线，框线连同补齐的空格都落在屏幕底色上，由整屏
 * 铺底补成 base 色。
 */
function withPanelChrome(rows: readonly Line[], panel: number, hint: string | undefined): readonly Line[] {
	return [rule(panel, hint), ...rows.map(margin), rule(panel, undefined)];

	function rule(width: number, text: string | undefined): Line {
		const line =
			text === undefined || text.length + 4 > width
				? styled("─".repeat(width), EDGE)
				: concat(styled("─".repeat(width - text.length - 4), EDGE), styled(`  ${text} ─`, DIM));
		return margin(padLine(line, width));
	}

	function margin(line: readonly Span[]): Line {
		return concat(plain(" ".repeat(OUTER_PAD)), line);
	}
}

/** 选中项越出窗口时整体平移，末端贴住最后一项。 */
function menuWindow(
	total: number,
	selected: number,
	limit: number,
): { readonly top: number; readonly visible: number } {
	const visible = Math.min(Math.max(1, limit), total);
	let top = 0;
	if (selected >= visible) top = Math.min(selected - visible + 1, total - visible);
	return { top, visible };
}
