import {
	ACCENT_COLOR,
	BOLD_OFF,
	MENU_MAX_VISIBLE,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	TEXT_COLOR,
	bottomBorder,
	displayWidth,
	keepVisible,
	menuHeight,
	padEnd,
	padStart,
	topBorder,
} from "./menu-panel.ts";

/**
 * 会话选择面板。
 *
 * 每个会话一行：最近活动时间、会话标识、第一条使用者提示；当前会话在右侧标 current。
 * 会话清单由调用方按更新时间从新到旧交进来，面板只负责显示与滚动。
 */

export interface SessionMenuItem {
	readonly id: string;
	readonly title: string;
	/** 最近活动时间的短表示；空串表示不显示 */
	readonly hint: string;
	readonly current: boolean;
}

export interface SessionMenuState {
	readonly items: readonly SessionMenuItem[];
	cursor: number;
	scrollTop: number;
}

export const SESSION_MENU_MAX_VISIBLE = MENU_MAX_VISIBLE;

/** " › " 的显示宽度；未选中行用等宽空格占位。 */
const PREFIX_WIDTH = 3;
const GAP = "  ";
const HINT_WIDTH = 3;
const CURRENT_WIDTH = 7;
/** 再窄就把 current 列让给标题。 */
const MIN_CURRENT_WIDTH = 48;
/** 会话标识是 16 位十六进制；文件里读到更长的也不无限占列。 */
const MAX_ID_WIDTH = 16;

export function sessionMenuHeight(itemCount: number): number {
	return menuHeight(itemCount);
}

export function renderSessionMenu(width: number, state: SessionMenuState): readonly string[] {
	const items = state.items;
	const visibleCount = Math.min(items.length, SESSION_MENU_MAX_VISIBLE);
	const top = keepVisible(state.scrollTop, state.cursor, items.length);
	const layout = layoutColumns(width, items);
	const lines: string[] = [topBorder(width, items.length)];

	for (let offset = 0; offset < visibleCount; offset += 1) {
		const item = items[top + offset];
		if (item === undefined) break;
		lines.push(row(width, item, top + offset === state.cursor, layout));
	}

	lines.push(bottomBorder(width));
	return lines;
}

interface Columns {
	readonly idWidth: number;
	/** 0 表示终端太窄，标题不显示 */
	readonly titleWidth: number;
	/** 0 表示终端太窄，连 current 也放不下 */
	readonly currentWidth: number;
}

function layoutColumns(width: number, items: readonly SessionMenuItem[]): Columns {
	const currentWidth = width >= MIN_CURRENT_WIDTH ? CURRENT_WIDTH : 0;
	const currentSegment = currentWidth > 0 ? GAP.length + currentWidth : 0;
	const fixed = PREFIX_WIDTH + HINT_WIDTH + GAP.length + GAP.length + currentSegment;
	const longestId = Math.max(1, ...items.map((item) => displayWidth(item.id)));
	const idWidth = Math.max(1, Math.min(longestId, MAX_ID_WIDTH, width - fixed));
	const titleWidth = Math.max(0, width - fixed - idWidth);
	return { idWidth, titleWidth, currentWidth };
}

function row(width: number, item: SessionMenuItem, selected: boolean, columns: Columns): string {
	const prefix = selected ? " › " : "   ";
	const primaryColor = selected ? SELECTED_TEXT_COLOR : TEXT_COLOR;
	const boldOff = selected ? BOLD_OFF : "";
	const prefixOutput = selected ? ` ${ACCENT_COLOR}›${primaryColor} ` : prefix;
	const hint = padStart(item.hint, HINT_WIDTH);
	const id = padEnd(item.id, columns.idWidth);
	const title = columns.titleWidth > 0 ? `${MUTED_COLOR}${padEnd(item.title, columns.titleWidth)}` : "";
	const current =
		columns.currentWidth > 0 ? padStart(item.current ? "current" : "", columns.currentWidth) : "";
	const head = `${prefix}${hint}${GAP}${id}${GAP}${padEnd(item.title, columns.titleWidth)}${
		columns.currentWidth > 0 ? `${GAP}${current}` : ""
	}`;
	const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
	const titleSegment = `${GAP}${title}`;
	const currentSegment =
		columns.currentWidth > 0 ? `${GAP}${ACCENT_COLOR}${current}` : "";

	return `${PANEL_BG}${primaryColor}${prefixOutput}${MUTED_COLOR}${hint}${GAP}${id}${boldOff}${titleSegment}${currentSegment}${padding}${RESET}`;
}
