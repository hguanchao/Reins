import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染层的窗口能力桥。
 *
 * 页面跑在 http://127.0.0.1 上，不能直接碰 Electron；这里只暴露工作区管理（选择/打开/
 * 改名）与主题同步，窗口按钮交给原生标题栏覆盖层，其余能力仍留在主进程。
 */
contextBridge.exposeInMainWorld("reinsDesktop", {
	chooseWorkspace: (): Promise<boolean> => ipcRenderer.invoke("workspace:choose") as Promise<boolean>,
	openWorkspaceFolder: (): void => {
		void ipcRenderer.invoke("workspace:reveal");
	},
	workspaceName: (): Promise<string | undefined> =>
		ipcRenderer.invoke("workspace:name") as Promise<string | undefined>,
	renameWorkspace: (name: string): Promise<boolean> =>
		ipcRenderer.invoke("workspace:rename", name) as Promise<boolean>,
	setTheme: (theme: "zai-dark" | "zai-light"): void => {
		void ipcRenderer.invoke("window:set-theme", theme);
	},
});
