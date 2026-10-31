import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染层的窗口能力桥。
 *
 * 页面跑在 http://127.0.0.1 上,不能直接碰 Electron;这里只暴露「弹出原生菜单」一件事,
 * 窗口的最小化/最大化/关闭由 titleBarOverlay 的原生按钮承担,不经过渲染层。
 */
contextBridge.exposeInMainWorld("reinsDesktop", {
	showMenu: (kind: "edit" | "window" | "help" | "about") => {
		void ipcRenderer.invoke("menu:show", kind);
	},
});
