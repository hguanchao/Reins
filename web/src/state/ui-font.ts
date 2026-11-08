/**
 * 字号设置，对齐 Codex 桌面版的双档模型：
 *
 * - 界面字号：整套字阶的基准（侧栏、按钮、小标签与会话正文按各自档位等比缩放），默认 14；
 * - 代码字号：代码块、diff 与工具输出的等宽字，独立于界面基准，默认 12。
 *
 * 两档各自独立，超范围的输入一律钳制到合法区间，不做静默重置；
 * 图标尺寸与组件盒高不跟着缩放，保证 12–18 的范围内布局稳定。
 */

const UI_STORAGE_KEY = "reins-ui-font-size";
const CODE_STORAGE_KEY = "reins-code-font-size";

export const UI_FONT_SIZES = [12, 13, 14, 15, 18] as const;
export const CODE_FONT_SIZES = [10, 11, 12, 13, 14] as const;

const UI_MIN = UI_FONT_SIZES[0];
const UI_MAX = UI_FONT_SIZES[UI_FONT_SIZES.length - 1];
const CODE_MIN = CODE_FONT_SIZES[0];
const CODE_MAX = CODE_FONT_SIZES[CODE_FONT_SIZES.length - 1];

export const DEFAULT_UI_FONT_SIZE = 14;
export const DEFAULT_CODE_FONT_SIZE = 12;

function readStoredSize(key: string, fallback: number, min: number, max: number): number {
	try {
		const value = Number(localStorage.getItem(key));
		if (Number.isInteger(value) && value >= min && value <= max) return value;
	} catch {
		// 存储不可用时用默认值
	}
	return fallback;
}

function writeStoredSize(key: string, value: number): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// 存不下就只在本次生效
	}
}

export function readUiFontSize(): number {
	return readStoredSize(UI_STORAGE_KEY, DEFAULT_UI_FONT_SIZE, UI_MIN, UI_MAX);
}

/** 界面字号落到根元素的 --ui-font-size：--fs-13 槽位与会话正文都引用它。 */
export function applyUiFontSize(size: number): void {
	const value = Math.min(UI_MAX, Math.max(UI_MIN, Math.round(size)));
	document.documentElement.style.setProperty("--ui-font-size", `${value}px`);
	writeStoredSize(UI_STORAGE_KEY, value);
}

export function readCodeFontSize(): number {
	return readStoredSize(CODE_STORAGE_KEY, DEFAULT_CODE_FONT_SIZE, CODE_MIN, CODE_MAX);
}

/** 代码字号落到根元素的 --code-font-size：代码块、diff 与工具输出引用它。 */
export function applyCodeFontSize(size: number): void {
	const value = Math.min(CODE_MAX, Math.max(CODE_MIN, Math.round(size)));
	document.documentElement.style.setProperty("--code-font-size", `${value}px`);
	writeStoredSize(CODE_STORAGE_KEY, value);
}

/** 首帧之前落好两档字号，避免刷新后要等设置页打开才生效。 */
export function applyStoredUiFontSize(): void {
	applyUiFontSize(readUiFontSize());
	applyCodeFontSize(readCodeFontSize());
}
