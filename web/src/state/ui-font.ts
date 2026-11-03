/** 界面字号：只改 --ui-font-size，不动根字号，图标与间距不跟着缩放。 */

const STORAGE_KEY = "reins-ui-font-size";
const MIN = 12;
const MAX = 18;

export const UI_FONT_SIZES = [13, 14, 15, 16] as const;

export function readUiFontSize(): number {
	try {
		const value = Number(localStorage.getItem(STORAGE_KEY));
		if (Number.isInteger(value) && value >= MIN && value <= MAX) return value;
	} catch {
		// 存储不可用时用默认值
	}
	return 14;
}

export function applyUiFontSize(size: number): void {
	const value = Math.min(MAX, Math.max(MIN, Math.round(size)));
	document.documentElement.style.setProperty("--ui-font-size", `${value}px`);
	document.documentElement.style.setProperty("--content-font-size", `${value}px`);
	try {
		localStorage.setItem(STORAGE_KEY, String(value));
	} catch {
		// 存不下就只在本次生效
	}
}

export function applyStoredUiFontSize(): void {
	applyUiFontSize(readUiFontSize());
}
