import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { PluginResult, ResolvedTheme, WorkspaceCreationResult } from "#desktop/contracts.ts";
import type { WindowControlAction } from "#desktop/window-controls.ts";

/**
 * 渲染层的窗口能力桥。
 *
 * 页面跑在 http://127.0.0.1 上，不能直接碰 Electron；这里只暴露工作区管理、文件选择、
 * 插件管理、通知、主题同步与窗控动作。窗口按钮由页面绘制，主进程收到动作后才操作窗口。
 */
contextBridge.exposeInMainWorld("reinsDesktop", {
	chooseWorkspace: (): Promise<boolean> =>
		ipcRenderer.invoke("workspace:choose") as Promise<boolean>,
	pickFile: (): Promise<string | undefined> =>
		ipcRenderer.invoke("files:pick") as Promise<string | undefined>,
	openWorkspaceFolder: (path?: string): void => {
		void ipcRenderer.invoke("workspace:reveal", path);
	},
	renameWorkspace: (path: string, name: string): Promise<boolean> =>
		ipcRenderer.invoke("workspace:rename", path, name) as Promise<boolean>,
	hideWorkspace: (path: string): Promise<boolean> =>
		ipcRenderer.invoke("workspace:hide", path) as Promise<boolean>,
	createWorkspace: (name: string): Promise<WorkspaceCreationResult> =>
		ipcRenderer.invoke("workspace:create", name) as Promise<WorkspaceCreationResult>,
	openSession: (workspacePath: string | null, cwd: string, id: string): Promise<boolean> =>
		ipcRenderer.invoke("workspace:open-session", workspacePath, cwd, id) as Promise<boolean>,
	newTaskInWorkspace: (path: string): Promise<boolean> =>
		ipcRenderer.invoke("workspace:new-task", path) as Promise<boolean>,
	newStandaloneTask: (): Promise<boolean> =>
		ipcRenderer.invoke("workspace:new-standalone") as Promise<boolean>,
	installPlugin: (): Promise<PluginResult> =>
		ipcRenderer.invoke("plugins:install") as Promise<PluginResult>,
	togglePlugin: (name: string, disabled: boolean): Promise<PluginResult> =>
		ipcRenderer.invoke("plugins:toggle", name, disabled) as Promise<PluginResult>,
	uninstallPlugin: (name: string): Promise<PluginResult> =>
		ipcRenderer.invoke("plugins:uninstall", name) as Promise<PluginResult>,
	notify: (payload: { readonly title: string; readonly body: string }): Promise<boolean> =>
		ipcRenderer.invoke("notification:show", payload) as Promise<boolean>,
	setTheme: (theme: ResolvedTheme): void => {
		void ipcRenderer.invoke("window:set-theme", theme);
	},
	controlWindow: (action: WindowControlAction): void => {
		void ipcRenderer.invoke("window:control", action);
	},
	isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:state") as Promise<boolean>,
	onWindowStateChanged: (listener: (maximized: boolean) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, value: unknown): void => listener(value === true);
		ipcRenderer.on("window:state-changed", handler);
		return () => ipcRenderer.removeListener("window:state-changed", handler);
	},
});
