import { displayWidth, fitToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 菜单面板的公共排版。
 *
 * 模型面板、思考等级面板与命令补全面板共用同一套边框、背景、列宽计算与滚动窗口规则，
 * 避免几处各写一份后出现偏差。颜色统一从 theme.ts 取。
 */

export const PANEL_BG = THEME.surface;
/** 悬停行底色；只表示指针位置，不改变选中项。 */
export const HOVER_BG = THEME.hoverBg;
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

/** 面板附加行：无匹配提示与按键提示。 */
export interface MenuListOptions {
	/** 没有条目时显示的一句话；省略时不画空态行 */
	readonly empty?: string;
	/** 面板底部的一行按键提示；省略时不画 */
	readonly hint?: string;
}

/** 面板总高度：上边框、可见行（或空态）、下边框与提示行。 */
export function menuListHeight(itemCount: number, options: MenuListOptions = {}): number {
	const visible = Math.min(Math.max(0, itemCount), MENU_MAX_VISIBLE);
	const empty = itemCount === 0 && options.empty !== undefined ? 1 : 0;
	const hint = options.hint === undefined ? 0 : 1;
	return visible + empty + 2 + hint;
}

/**
 * 移动列表光标并保持可见。
 *
 * 键盘移动首尾相接；滚轮和翻页用不循环的夹取，避免滚过头时突然跳回另一端。
 */
export function moveMenuSelection(
	menu: { cursor: number; scrollTop: number },
	delta: number,
	count: number,
	wrap: boolean,
): void {
	if (count <= 0) {
		menu.cursor = 0;
		menu.scrollTop = 0;
		return;
	}
	const next = menu.cursor + delta;
	menu.cursor = wrap
		? ((next % count) + count) % count
		: Math.min(count - 1, Math.max(0, next));
	menu.scrollTop = keepVisible(menu.scrollTop, menu.cursor, count);
}

/** 上边框右侧的数量；数量变化时只伸缩左侧长横线。 */
function topBorder(width: number, position: number, count: number): string {
	// 超过一屏时显示「当前位置/总数」，滚动后能看出自己在哪里
	const label = count > MENU_MAX_VISIBLE ? ` ${position}/${count} ` : ` ${count} `;
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
	/** 指针悬停的条目；只影响底色，不改变 cursor */
	hover?: number;
}

/**
 * 画出「上边框 + 可见条目（或空态）+ 下边框 + 提示」的完整面板。
 *
 * 五个选择面板的滚动窗口、可见行裁剪与边框顺序完全一致，只有列宽计算与单行排版不同，
 * 那两处由调用方传入。只写一份，面板之间才不会在边界条件上慢慢分叉。
 */
export function menuListLines<T, L>(
	width: number,
	items: readonly T[],
	state: MenuListState,
	layout: (width: number, items: readonly T[]) => L,
	row: (width: number, item: T, selected: boolean, hovered: boolean, layout: L) => string,
	options: MenuListOptions = {},
): readonly string[] {
	const visibleCount = Math.min(items.length, MENU_MAX_VISIBLE);
	const top = keepVisible(state.scrollTop, state.cursor, items.length);
	const columns = layout(width, items);
	const lines: string[] = [
		topBorder(width, Math.min(state.cursor + 1, items.length), items.length),
	];

	if (visibleCount === 0) {
		if (options.empty !== undefined) lines.push(emptyLine(width, options.empty));
	} else {
		for (let offset = 0; offset < visibleCount; offset += 1) {
			const index = top + offset;
			const item = items[index];
			if (item === undefined) break;
			lines.push(row(width, item, index === state.cursor, index === state.hover && index !== state.cursor, columns));
		}
	}

	lines.push(bottomBorder(width));
	if (options.hint !== undefined) lines.push(hintLine(width, options.hint));
	return lines;
}

/** 空态行：面板保留，告诉使用者是没匹配而不是补全坏了。 */
function emptyLine(width: number, text: string): string {
	const visible = fitToWidth(`  ${text}`, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
	return `${PANEL_BG}${SUBTLE_COLOR}${visible}${padding}${RESET}`;
}

/** 面板底部的按键提示。 */
function hintLine(width: number, hint: string): string {
	const visible = fitToWidth(`  ${hint}`, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
	return `${PANEL_BG}${SUBTLE_COLOR}${visible}${padding}${RESET}`;
}

export function padEnd(text: string, width: number): string {
	const visible = fitToWidth(text, width);
	return visible + " ".repeat(Math.max(0, width - displayWidth(visible)));
}

export function padStart(text: string, width: number): string {
	const visible = fitToWidth(text, width);
	return " ".repeat(Math.max(0, width - displayWidth(visible))) + visible;
}
