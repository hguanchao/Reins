import type { ResolvedTheme } from "#desktop/contracts.ts";

/**
 * 界面令牌在桌面壳的镜像。
 *
 * 窗口底色与首屏 loading 页必须和页面首帧同色，否则切换主题时会闪一帧旧底色。
 * 窗控改由页面自绘后，系统覆盖层的配色不再需要在这里维护。
 */

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
