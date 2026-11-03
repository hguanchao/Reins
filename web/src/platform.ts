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
