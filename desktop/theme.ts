import type { ResolvedTheme } from "#desktop/contracts.ts";

/**
 * 界面令牌在桌面壳的镜像。
 *
 * 窗口底色、原生标题栏覆盖层与首屏 loading 页必须和页面首帧同色，否则切换主题时会
 * 闪一帧旧底色。这些值集中放一处，窗口构造、主题变更、loading 页三路共用同一份定义。
 */

export const CAPTION_HEIGHT = 34;

export interface TitleBarOverlayOptions {
	readonly color: string;
	readonly symbolColor: string;
	readonly height: number;
}

export interface WindowPalette {
	readonly background: string;
	readonly foreground: string;
	readonly rule: string;
	readonly accent: string;
}

export const WINDOW_PALETTE: Readonly<Record<ResolvedTheme, WindowPalette>> = {
	"zai-light": {
		background: "#f6f6f5",
		foreground: "#545454",
		rule: "rgba(0,0,0,.16)",
		accent: "#0b0b0b",
	},
	"zai-dark": {
		background: "#090909",
		foreground: "#a5a5a1",
		rule: "rgba(255,255,255,.18)",
		accent: "#f2f2f0",
	},
};

/** 系统深浅色是选择方式，不是第三套配色；这里直接落到实际主题。 */
export function themeFromSystem(dark: boolean): ResolvedTheme {
	return dark ? "zai-dark" : "zai-light";
}

export function windowBackgroundColor(theme: ResolvedTheme): string {
	return WINDOW_PALETTE[theme].background;
}

export function titleBarOverlay(theme: ResolvedTheme): TitleBarOverlayOptions {
	return {
		color: WINDOW_PALETTE[theme].background,
		symbolColor: WINDOW_PALETTE[theme].accent,
		height: CAPTION_HEIGHT,
	};
}
