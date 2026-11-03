import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染层的窗口能力桥。
 *
 * 页面跑在 http://127.0.0.1 上，不能直接碰 Electron；这里只暴露窗口控制、
 * 工作区选择与主题同步，其余能力仍留在主进程。
 */
contextBridge.exposeInMainWorld("reinsDesktop", {
	chooseWorkspace: (): Promise<boolean> => ipcRenderer.invoke("workspace:choose") as Promise<boolean>,
	minimize: (): void => {
		void ipcRenderer.invoke("window:minimize");
	},
	toggleMaximize: (): void => {
		void ipcRenderer.invoke("window:toggle-maximize");
	},
	close: (): void => {
		void ipcRenderer.invoke("window:close");
	},
	isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized") as Promise<boolean>,
	onMaximizedChange: (listener: (maximized: boolean) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
			listener(value === true);
		};
		ipcRenderer.on("window:maximized-changed", handler);
		return () => {
			ipcRenderer.removeListener("window:maximized-changed", handler);
		};
	},
	setTheme: (theme: "zai-dark" | "zai-light"): void => {
		void ipcRenderer.invoke("window:set-theme", theme);
	},
});
