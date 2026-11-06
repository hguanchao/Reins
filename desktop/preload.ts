import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染层的窗口能力桥。
 *
 * 页面跑在 http://127.0.0.1 上，不能直接碰 Electron；这里只暴露工作区管理（选择/打开/
 * 改名）与主题同步，窗口按钮交给原生标题栏覆盖层，其余能力仍留在主进程。
 */
contextBridge.exposeInMainWorld("reinsDesktop", {
	chooseWorkspace: (): Promise<boolean> => ipcRenderer.invoke("workspace:choose") as Promise<boolean>,
		openWorkspaceFolder: (path?: string): void => {
			void ipcRenderer.invoke("workspace:reveal", path);
		},
		renameWorkspace: (path: string, name: string): Promise<boolean> =>
			ipcRenderer.invoke("workspace:rename", path, name) as Promise<boolean>,
		openSession: (workspacePath: string | null, cwd: string, id: string): Promise<boolean> =>
			ipcRenderer.invoke("workspace:open-session", workspacePath, cwd, id) as Promise<boolean>,
		newTaskInWorkspace: (path: string): Promise<boolean> =>
			ipcRenderer.invoke("workspace:new-task", path) as Promise<boolean>,
		installPlugin: (): Promise<{ ok: boolean; name?: string; error?: string }> =>
			ipcRenderer.invoke("plugins:install") as Promise<{ ok: boolean; name?: string; error?: string }>,
		togglePlugin: (name: string, disabled: boolean): Promise<{ ok: boolean; error?: string }> =>
			ipcRenderer.invoke("plugins:toggle", name, disabled) as Promise<{ ok: boolean; error?: string }>,
		uninstallPlugin: (name: string): Promise<{ ok: boolean; error?: string }> =>
			ipcRenderer.invoke("plugins:uninstall", name) as Promise<{ ok: boolean; error?: string }>,
		notify: (payload: { readonly title: string; readonly body: string }): Promise<boolean> =>
			ipcRenderer.invoke("notification:show", payload) as Promise<boolean>,
	setTheme: (theme: "zai-dark" | "zai-light"): void => {
		void ipcRenderer.invoke("window:set-theme", theme);
	},
});
