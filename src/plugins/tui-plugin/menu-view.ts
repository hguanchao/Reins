import { concat, mergeStyles, padLine, plain, styled, truncateLine, type Line, type Span, type Style } from "../../tui/index.ts";
import { OUTER_PAD } from "./layout.ts";
import type { FileEntry } from "./file-search.ts";
import type { SlashCommand } from "./slash-menu.ts";
import { ACCENT, BAND, BRIGHT, DIM, EDGE, PATH, SELECT_BG, TITLE } from "./theme.ts";

/**
 * 输入框上方的候选面板。
 *
 * 命令与文件共用同一套版式：先一条横贯面板的框线（右侧嵌结果计数），下面是候选行，收尾再
 * 一条框线。候选行整行铺底，被选中的一行亮一档并带 ❯ 前缀；文件目录带尾斜杠并用强调色。
 * 面板整体缩进会话区外边距，候选内容再比框线缩进两列。
 */

export const MAX_MENU_ROWS = 8;

/** 框线占了候选区上方的行数：屏幕行号换算候选行号时要扣掉它。 */
export const MENU_CHROME_ROWS = 1;

/** 候选内容相对面板框线的缩进。 */
const MENU_INSET = 2;

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
): MenuLayout {
	const window = menuWindow(items.length, selected, limit);
	if (window.visible === 0) return { rows: [], top: 0, visible: 0 };

	const panel = panelWidth(width);
	const visible = items.slice(window.top, window.top + window.visible);
	const labelWidth = Math.min(24, Math.max(...visible.map((item) => item.name.length)) + 1);
	const rows = visible.map((item, offset) => {
		const active = window.top + offset === selected;
		const background = active ? SELECT_BG : BAND;
		const label = `/${item.name}`;
		const gap = Math.max(2, labelWidth - label.length + 2);
		const content = concat(
			styled(active ? "❯ " : "  ", mergeStyles(active ? TITLE : undefined, background) ?? background),
			styled(label, mergeStyles(active ? TITLE : ACCENT, background) ?? background),
			styled(" ".repeat(gap), background),
			styled(item.description, mergeStyles(active ? BRIGHT : DIM, background) ?? background),
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
): MenuLayout {
	const window = menuWindow(items.length, selected, limit);
	if (window.visible === 0) return { rows: [], top: 0, visible: 0 };

	const panel = panelWidth(width);
	const rows = items.slice(window.top, window.top + window.visible).map((item, offset) => {
		const active = window.top + offset === selected;
		const background = active ? SELECT_BG : BAND;
		const color = active ? TITLE : item.kind === "directory" ? ACCENT : PATH;
		const path = item.kind === "directory" ? `${item.path}/` : item.path;
		const content = concat(
			styled(active ? "❯ " : "  ", mergeStyles(active ? TITLE : undefined, background) ?? background),
			styled("@", mergeStyles(DIM, background) ?? background),
			styled(path, mergeStyles(color, background) ?? background),
		);
		return itemRow(content, panel, background);
	});
	return { rows: withPanelChrome(rows, panel, hint), top: window.top, visible: rows.length };
}

/** 面板内部可用的宽度：扣掉两侧外边距。 */
function panelWidth(width: number): number {
	return Math.max(1, width - OUTER_PAD * 2);
}

/** 一行候选：先缩进两列，整行铺到面板宽度；外边距由面板框线统一补。 */
function itemRow(content: Line, panel: number, background: Style): Line {
	const line = truncateLine(concat(plain(" ".repeat(MENU_INSET)), content), panel);
	return padLine(line, panel, background);
}

/** 面板框线：上下两条横线，右上角嵌结果计数；整个面板缩进外边距。 */
function withPanelChrome(rows: readonly Line[], panel: number, hint: string | undefined): readonly Line[] {
	return [rule(panel, hint), ...rows.map(margin), rule(panel, undefined)];

	function rule(width: number, text: string | undefined): Line {
		const line =
			text === undefined || text.length + 4 > width
				? styled("─".repeat(width), { color: EDGE.color, background: BAND.background })
				: concat(
						styled("─".repeat(width - text.length - 4), { color: EDGE.color, background: BAND.background }),
						styled(`  ${text} ─`, { color: DIM.color, background: BAND.background }),
					);
		return margin(padLine(line, width, BAND));
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
