export interface PluginActionResult {
	readonly ok: boolean;
	readonly name?: string;
	readonly error?: string;
}

/** 新建工作空间的结果；失败原因直接显示在弹窗里。 */
export interface WorkspaceCreationResult {
	readonly ok: boolean;
	readonly error?: string;
}

/** 桌面壳注入的能力；浏览器里不存在，相关入口据此隐藏。 */
export interface ReinsDesktopBridge {
	chooseWorkspace(): Promise<boolean>;
	/** 唤起系统文件选择器；返回选中文件的绝对路径，取消时返回 undefined */
	pickFile(defaultPath?: string): Promise<string | undefined>;
	/** 用系统资源管理器打开指定目录 */
	openWorkspaceFolder(path?: string): void;
	renameWorkspace(path: string, name: string): Promise<boolean>;
	/** 从侧栏移除项目：只隐藏登记条目，名下活动与归档任务都保留 */
	hideWorkspace(path: string): Promise<boolean>;
	/** 新建工作空间：本地创建同名文件夹并切换，非法或重名由主进程拒绝 */
	createWorkspace(name: string): Promise<WorkspaceCreationResult>;
	openSession(workspacePath: string | null, cwd: string, id: string): Promise<boolean>;
	newTaskInWorkspace(path: string): Promise<boolean>;
	/** 新建独立任务：自动建一块一次性目录并切过去，任务算未绑定 */
	newStandaloneTask(): Promise<boolean>;
	/** 选择本地插件目录并安装；成功后服务进程会重启 */
	installPlugin(): Promise<PluginActionResult>;
	/** 启停插件；成功后服务进程会重启 */
	togglePlugin(name: string, disabled: boolean): Promise<PluginActionResult>;
	/** 卸载插件；成功后服务进程会重启 */
	uninstallPlugin(name: string): Promise<PluginActionResult>;
	/** 弹一条系统通知；桌面壳不支持时返回 false */
	notify(payload: { readonly title: string; readonly body: string }): Promise<boolean>;
	setTheme(theme: "zai-dark" | "zai-light"): void;
	/** 自绘窗控递交动作名，由主进程落到窗口方法 */
	controlWindow(action: "minimize" | "toggle-maximize" | "close"): void;
	/** 当前是否最大化：窗控按钮据此在「最大化 / 还原」之间切换 */
	isWindowMaximized(): Promise<boolean>;
	/** 订阅最大化状态变化；返回取消订阅函数 */
	onWindowStateChanged(listener: (maximized: boolean) => void): () => void;
}

declare global {
	interface Window {
		reinsDesktop?: ReinsDesktopBridge;
	}
}

export function desktopBridge(): ReinsDesktopBridge | undefined {
	return window.reinsDesktop;
}
