/** 桌面壳注入的能力；浏览器里不存在，相关入口据此隐藏。 */
export interface ReinsDesktopBridge {
	showMenu(kind?: "edit" | "window" | "help" | "about"): void;
	minimize(): void;
	toggleMaximize(): void;
	close(): void;
	isMaximized(): Promise<boolean>;
	onMaximizedChange(listener: (maximized: boolean) => void): () => void;
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
