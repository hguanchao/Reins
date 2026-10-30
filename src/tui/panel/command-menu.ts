import {
	type MenuListState,
	ACCENT_COLOR,
	BOLD_OFF,
	DISABLED_COLOR,
	HOVER_BG,
	MENU_MAX_VISIBLE,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	TEXT_COLOR,
	menuListHeight,
	menuListLines,
	padEnd,
} from "./menu-panel.ts";
import { displayWidth } from "../render/text.ts";
import { PANEL } from "../copy.ts";

/**
 * 斜杠命令补全面板。
 *
 * 输入以 `/` 开头时出现在输入框上方，继续输入按命令名过滤；面板本身不接收文字，只负责
 * 显示匹配项与当前高亮项。样式与模型面板一致，区别是没有 current 列，多了命令说明。
 */

export interface CommandMenuItem {
	/** 不含前导斜杠的命令名 */
	readonly name: string;
	readonly description: string;
	/** 配置不可用时仍显示，但标记为不可执行 */
	readonly enabled: boolean;
	/** 不在补全列表里主动出现；完整输入命令名仍可执行 */
	readonly hidden?: boolean;
}

export interface CommandMenuState extends MenuListState {
	readonly items: readonly CommandMenuItem[];
}

/** " › " 的显示宽度；未选中行用等宽空格占位，和输入框前缀对齐。 */
const PREFIX_WIDTH = 3;
/** 命令名与说明之间的间距。 */
const GAP = "    ";
const GAP_WIDTH = displayWidth(GAP);
const EMPTY = PANEL.noMatchingCommands;

export function commandMenuHeight(itemCount: number, maxVisible = MENU_MAX_VISIBLE): number {
	return menuListHeight(itemCount, { empty: EMPTY }, maxVisible);
}

export function renderCommandMenu(
	width: number,
	state: CommandMenuState,
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	return menuListLines(width, state.items, state, layoutColumns, row, { empty: EMPTY }, maxVisible);
}

interface Columns {
	readonly nameWidth: number;
	/** 0 表示终端太窄，隐藏说明列 */
	readonly descriptionWidth: number;
}

function layoutColumns(width: number, items: readonly CommandMenuItem[]): Columns {
	const longestName = Math.max(
		1,
		...items.map((item) => displayWidth(`/${item.name}`)),
	);
	const available = Math.max(1, width - PREFIX_WIDTH);
	// 说明列只在确实放得下时保留；窄终端把宽度全给命令名，否则命令名只剩省略号
	const canShowDescription = available - longestName >= GAP_WIDTH + 4;
	const nameWidth = canShowDescription
		? Math.min(longestName, Math.max(1, available - GAP_WIDTH - 4))
		: Math.min(longestName, available);
	const remaining = available - nameWidth - GAP_WIDTH;
	const descriptionWidth = canShowDescription && remaining >= 4 ? remaining : 0;
	return { nameWidth, descriptionWidth };
}

function row(
	width: number,
	item: CommandMenuItem,
	selected: boolean,
	hovered: boolean,
	columns: Columns,
): string {
	const background = selected ? PANEL_BG : hovered ? HOVER_BG : PANEL_BG;
	const prefix = selected ? " › " : "   ";
	const name = padEnd(`/${item.name}`, columns.nameWidth);
	const description =
		columns.descriptionWidth > 0 ? padEnd(item.description, columns.descriptionWidth) : "";
	const descriptionSegment =
		columns.descriptionWidth > 0 ? `${GAP}${description}` : "";
	const head = `${prefix}${name}${descriptionSegment}`;
	const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
	const nameColor = item.enabled
		? selected
			? SELECTED_TEXT_COLOR
			: TEXT_COLOR
		: DISABLED_COLOR;
	const boldOff = selected && item.enabled ? BOLD_OFF : "";
	const prefixOutput = selected
		? ` ${ACCENT_COLOR}›${nameColor} `
		: prefix;
	const descriptionOutput =
		columns.descriptionWidth > 0 ? `${GAP}${MUTED_COLOR}${description}` : "";

	return `${background}${nameColor}${prefixOutput}${name}${boldOff}${descriptionOutput}${padding}${RESET}`;
}
