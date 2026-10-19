import {
	ACCENT_COLOR,
	BOLD_OFF,
	DISABLED_COLOR,
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
	topBorder,
} from "./menu-panel.ts";

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
}

export interface CommandMenuState {
	readonly items: readonly CommandMenuItem[];
	cursor: number;
	scrollTop: number;
}

export const COMMAND_MENU_MAX_VISIBLE = MENU_MAX_VISIBLE;
export function commandMenuHeight(itemCount: number): number {
	return menuHeight(itemCount);
}

export function renderCommandMenu(width: number, state: CommandMenuState): readonly string[] {
	const items = state.items;
	const visibleCount = Math.min(items.length, COMMAND_MENU_MAX_VISIBLE);
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
	readonly nameWidth: number;
	/** 0 表示终端太窄，隐藏说明列 */
	readonly descriptionWidth: number;
}

function layoutColumns(width: number, items: readonly CommandMenuItem[]): Columns {
	const longestName = Math.max(
		1,
		...items.map((item) => displayWidth(`/${item.name}`)),
	);
	const nameWidth = Math.min(longestName, Math.max(1, width - 5 - 2 - 4));
	const remaining = width - 5 - nameWidth - 2;
	const descriptionWidth = remaining >= 4 ? remaining : 0;
	return { nameWidth, descriptionWidth };
}

function row(
	width: number,
	item: CommandMenuItem,
	selected: boolean,
	columns: Columns,
): string {
	const prefix = selected ? "  ›  " : "     ";
	const name = padEnd(`/${item.name}`, columns.nameWidth);
	const description =
		columns.descriptionWidth > 0 ? padEnd(item.description, columns.descriptionWidth) : "";
	const descriptionSegment =
		columns.descriptionWidth > 0 ? `${" ".repeat(2)}${description}` : "";
	const head = `${prefix}${name}${descriptionSegment}`;
	const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
	const nameColor = item.enabled
		? selected
			? SELECTED_TEXT_COLOR
			: TEXT_COLOR
		: DISABLED_COLOR;
	const boldOff = selected && item.enabled ? BOLD_OFF : "";
	const prefixOutput = selected
		? `  ${ACCENT_COLOR}›${nameColor}  `
		: prefix;
	const descriptionOutput =
		columns.descriptionWidth > 0 ? `${" ".repeat(2)}${MUTED_COLOR}${description}` : "";

	return `${PANEL_BG}${nameColor}${prefixOutput}${name}${boldOff}${descriptionOutput}${padding}${RESET}`;
}
