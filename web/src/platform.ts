/** 桌面壳注入的能力；浏览器里不存在，相关入口据此隐藏。 */
export interface ReinsDesktopBridge {
	chooseWorkspace(): Promise<boolean>;
	setTheme(theme: "zai-dark" | "zai-light"): void;
}

declare global {
	interface Window {
		reinsDesktop?: ReinsDesktopBridge;
	}
}

export function desktopBridge(): ReinsDesktopBridge | undefined {
	return window.reinsDesktop;
}

/**
 * 桌面壳用原生标题栏覆盖窗口顶部，标题栏内承载窗控与全局控制；浏览器没有这层。
 * 与 index.html 里给标题栏让位的判断同源：有桥才有原生标题栏。
 */
export function hasNativeTitlebar(): boolean {
	return window.reinsDesktop !== undefined;
}
