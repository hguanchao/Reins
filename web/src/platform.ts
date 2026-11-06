export interface PluginActionResult {
	readonly ok: boolean;
	readonly name?: string;
	readonly error?: string;
}

/** 桌面壳注入的能力；浏览器里不存在，相关入口据此隐藏。 */
export interface ReinsDesktopBridge {
	chooseWorkspace(): Promise<boolean>;
	/** 用系统资源管理器打开指定目录 */
	openWorkspaceFolder(path?: string): void;
	renameWorkspace(path: string, name: string): Promise<boolean>;
	openSession(workspacePath: string | null, cwd: string, id: string): Promise<boolean>;
	newTaskInWorkspace(path: string): Promise<boolean>;
	/** 选择本地插件目录并安装；成功后服务进程会重启 */
	installPlugin(): Promise<PluginActionResult>;
	/** 启停插件；成功后服务进程会重启 */
	togglePlugin(name: string, disabled: boolean): Promise<PluginActionResult>;
	/** 卸载插件；成功后服务进程会重启 */
	uninstallPlugin(name: string): Promise<PluginActionResult>;
	/** 弹一条系统通知；桌面壳不支持时返回 false */
	notify(payload: { readonly title: string; readonly body: string }): Promise<boolean>;
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
