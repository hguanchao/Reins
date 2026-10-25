import { displayWidth, fitToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 菜单面板的公共排版。
 *
 * 模型面板、思考等级面板与命令补全面板共用同一套边框、背景、列宽计算与滚动窗口规则，
 * 避免几处各写一份后出现偏差。颜色统一从 theme.ts 取。
 */

export const PANEL_BG = THEME.surface;
export const TEXT_COLOR = THEME.textPrimary;
export const MUTED_COLOR = THEME.textSecondary;
export const SUBTLE_COLOR = THEME.textSubtle;
export const DISABLED_COLOR = THEME.textDisabled;
export const ACCENT_COLOR = THEME.accent;
export const SELECTED_TEXT_COLOR = THEME.selectedText;
export const BOLD_OFF = THEME.boldOff;
export const BORDER_COLOR = THEME.border;
export const RESET = THEME.reset;

/** 面板最多显示的条目行数。 */
export const MENU_MAX_VISIBLE = 8;
/** 上边框数量右侧固定的横线数。 */
const TAIL_DASHES = 4;

/** 面板总高度：上边框、可见行、下边框。 */
export function menuHeight(itemCount: number): number {
	return Math.min(Math.max(0, itemCount), MENU_MAX_VISIBLE) + 2;
}

/** 上边框右侧的数量；数量变化时只伸缩左侧长横线。 */
function topBorder(width: number, count: number): string {
	const label = ` ${count} `;
	const labelWidth = displayWidth(label);
	const tail = Math.min(TAIL_DASHES, Math.max(0, width - labelWidth));
	const left = Math.max(0, width - labelWidth - tail);
	return `${BORDER_COLOR}${"─".repeat(left)}${SUBTLE_COLOR}${label}${BORDER_COLOR}${"─".repeat(tail)}${RESET}`;
}

function bottomBorder(width: number): string {
	return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;
}

/** 让光标始终落在可见窗口内。 */
export function keepVisible(scrollTop: number, cursor: number, itemCount: number): number {
	const visible = Math.min(Math.max(0, itemCount), MENU_MAX_VISIBLE);
	const maxTop = Math.max(0, itemCount - visible);
	let top = Math.min(Math.max(0, scrollTop), maxTop);
	if (cursor < top) top = cursor;
	if (cursor >= top + visible) top = cursor - visible + 1;
	return top;
}

/** 面板列表的公共状态；各面板的条目状态都至少含这两个字段。 */
interface MenuListState {
	cursor: number;
	scrollTop: number;
}

/**
 * 画出「上边框 + 可见条目 + 下边框」的完整面板。
 *
 * 五个选择面板的滚动窗口、可见行裁剪与边框顺序完全一致，只有列宽计算与单行排版不同，
 * 那两处由调用方传入。只写一份，面板之间才不会在边界条件上慢慢分叉。
 */
export function menuListLines<T, L>(
	width: number,
	items: readonly T[],
	state: MenuListState,
	layout: (width: number, items: readonly T[]) => L,
	row: (width: number, item: T, selected: boolean, layout: L) => string,
): readonly string[] {
	const visibleCount = Math.min(items.length, MENU_MAX_VISIBLE);
	const top = keepVisible(state.scrollTop, state.cursor, items.length);
	const columns = layout(width, items);
	const lines: string[] = [topBorder(width, items.length)];

	for (let offset = 0; offset < visibleCount; offset += 1) {
		const item = items[top + offset];
		if (item === undefined) break;
		lines.push(row(width, item, top + offset === state.cursor, columns));
	}

	lines.push(bottomBorder(width));
	return lines;
}

export function padEnd(text: string, width: number): string {
	const visible = fitToWidth(text, width);
	return visible + " ".repeat(Math.max(0, width - displayWidth(visible)));
}

export function padStart(text: string, width: number): string {
	const visible = fitToWidth(text, width);
	return " ".repeat(Math.max(0, width - displayWidth(visible))) + visible;
}
