import { concat, mergeStyles, padLine, styled, truncateLine, type Line } from "../../tui/index.ts";
import type { FileEntry } from "./file-search.ts";
import type { SlashCommand } from "./slash-menu.ts";
import { ACCENT, BAND, BRIGHT, DIM, PATH, SELECT_BG, TITLE } from "./theme.ts";

/**
 * 输入框上方的候选列表。
 *
 * 命令与文件共用同一套窗口规则：最多显示若干行，选中项超出一屏时让窗口跟着它移动。每行
 * 整行铺底，选中行比普通行亮一档；文件目录带尾斜杠并用强调色。
 */

export const MAX_MENU_ROWS = 8;

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

	const visible = items.slice(window.top, window.top + window.visible);
	const labelWidth = Math.min(24, Math.max(...visible.map((item) => item.name.length)) + 1);
	const rows = visible.map((item, offset) => {
		const active = window.top + offset === selected;
		const background = active ? SELECT_BG : BAND;
		const label = `/${item.name}`;
		const gap = Math.max(2, labelWidth - label.length + 2);
		const content = concat(
			styled("  ", background),
			styled(label, mergeStyles(active ? TITLE : ACCENT, background) ?? background),
			styled(" ".repeat(gap), background),
			styled(item.description, mergeStyles(active ? BRIGHT : DIM, background) ?? background),
		);
		return padLine(truncateLine(content, width), width, background);
	});
	return { rows, top: window.top, visible: rows.length };
}

export function fileMenuRows(
	items: readonly FileEntry[],
	selected: number,
	width: number,
	limit: number,
): MenuLayout {
	const window = menuWindow(items.length, selected, limit);
	if (window.visible === 0) return { rows: [], top: 0, visible: 0 };

	const rows = items.slice(window.top, window.top + window.visible).map((item, offset) => {
		const active = window.top + offset === selected;
		const background = active ? SELECT_BG : BAND;
		const color = active ? TITLE : item.kind === "directory" ? ACCENT : PATH;
		const path = item.kind === "directory" ? `${item.path}/` : item.path;
		const content = concat(
			styled("  ", background),
			styled("@", mergeStyles(DIM, background) ?? background),
			styled(path, mergeStyles(color, background) ?? background),
		);
		return padLine(truncateLine(content, width), width, background);
	});
	return { rows, top: window.top, visible: rows.length };
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
