import { displayWidth, truncateToWidth } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";

/**
 * 整屏页的公共排版件。
 *
 * 检查点、作业与沙箱页共用同一套标题、弱提示行与底部动作条：都带底色铺满整行、
 * 底部都先画一条分隔线。各页只决定内容与按键文案，排版规则留在这里一份。
 */

const RESET = THEME.reset;
const META_COLOR = THEME.textSecondary;
const SUBTLE_COLOR = THEME.textSubtle;

/** 页面标题行：主色标题，右侧用空格铺满整行。 */
export function pageTitle(text: string, width: number): string {
	const columns = Math.max(0, width);
	const visible = truncateToWidth(text, columns);
	return `${THEME.accent}${visible}${RESET}${" ".repeat(Math.max(0, columns - displayWidth(visible)))}`;
}

/** 缩进两列的弱提示行；超宽时截断。 */
export function subtleLine(text: string, width: number): string {
	const columns = Math.max(0, width);
	return `${SUBTLE_COLOR}  ${truncateToWidth(text, Math.max(0, columns - 2))}${RESET}`;
}

/** 底部动作条的按键定义：按键、说明、颜色。 */
type ActionKey = readonly [key: string, label: string, color: string];

/**
 * 底部动作条：一条分隔线加一行按键提示。
 *
 * 放不下时退回纯文本截断——带色的版本每段都有转义序列，宽度只能另算一遍。
 */
export function actionLines(width: number, keys: readonly ActionKey[]): readonly string[] {
	const columns = Math.max(0, width);
	const rule = `${THEME.border}${"─".repeat(columns)}${RESET}`;
	if (columns === 0) return ["", ""];

	const plain = keys.map(([key, label]) => `${key} ${label}`).join("  ");
	// 补白按纯文本算：带色的那行混着转义序列，直接量它会少补一半
	const fits = displayWidth(plain) <= columns;
	const visible = fits
		? keys.map(([key, label, color]) => `${color}${key}${RESET} ${META_COLOR}${label}${RESET}`).join("  ")
		: truncateToWidth(plain, columns);
	const used = fits ? displayWidth(plain) : displayWidth(visible);
	return [rule, `${visible}${" ".repeat(Math.max(0, columns - used))}`];
}
