import {
	BrowserWindow,
	Menu,
	Notification,
	ipcMain,
	nativeImage,
	shell,
} from "electron";

import { parseNotification, parseTheme } from "#desktop/contracts.ts";
import type { DesktopPaths } from "#desktop/paths.ts";
import { titleBarOverlay, windowBackgroundColor, WINDOW_PALETTE } from "#desktop/theme.ts";
import type { ResolvedTheme } from "#desktop/contracts.ts";

/**
 * 窗口与窗口级 IPC。
 *
 * 无边框窗由系统原生覆盖层承载窗控，页面只负责 34px 拖拽条；外链一律交给系统浏览器，
 * 同源路由放行。主题与通知这两个 handler 只做窗口层面的事，参数收窄统一走 contracts。
 */

/** 隐藏菜单只为保住重载与开发者工具的快捷键，菜单本身永远不显示。 */
export const HIDDEN_MENU = Menu.buildFromTemplate([
	{
		label: "界面",
		submenu: [
			{ role: "reload", label: "重新加载界面" },
			{ role: "toggleDevTools", label: "开发者工具" },
		],
	},
]);

/** 窗口先出的 loading 页：纯内联，毫秒级可见；真就绪后由 loadURL 整页换掉。 */
export function loadingPage(): string {
	const light = WINDOW_PALETTE["zai-light"];
	const dark = WINDOW_PALETTE["zai-dark"];
	return (
		"data:text/html;charset=utf-8," +
		encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Reins</title>
<style>
	body{margin:0;background:${light.background};color:${light.foreground};
		font-family:"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
		height:100vh;display:flex;align-items:center;justify-content:center}
	.c{text-align:center}
	.s{width:24px;height:24px;margin:0 auto 14px;border-radius:50%;
		border:2px solid ${light.rule};border-top-color:${light.accent};animation:r 0.8s linear infinite}
	p{margin:0;font-size:13px;letter-spacing:0.02em}
	@keyframes r{to{transform:rotate(360deg)}}
	@media (prefers-color-scheme: dark){
		body{background:${dark.background};color:${dark.foreground}}
		.s{border-color:${dark.rule};border-top-color:${dark.accent}}
	}
</style><div class="c"><div class="s"></div><p>正在启动 Reins</p></div>`)
	);
}

export function createMainWindow(paths: DesktopPaths, theme: ResolvedTheme): BrowserWindow {
	const icon = nativeImage.createFromPath(paths.icon);
	const window = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 880,
		minHeight: 600,
		title: "Reins",
		...(icon.isEmpty() ? {} : { icon }),
		backgroundColor: windowBackgroundColor(theme),
		show: false,
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		...(process.platform === "win32" ? { titleBarOverlay: titleBarOverlay(theme) } : {}),
		webPreferences: {
			sandbox: true,
			preload: paths.preload,
		},
	});
	// 构造参数里的 icon 在部分 Windows 版本上会被任务栏忽略，创建后再显式设一次
	if (process.platform !== "darwin" && !icon.isEmpty()) window.setIcon(icon);
	return window;
}

export function installNavigationGuards(
	window: BrowserWindow,
	getOrigin: () => string | undefined,
): void {
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith("http://127.0.0.1:")) void shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		const origin = getOrigin();
		if (origin !== undefined && url.startsWith(origin)) return;
		event.preventDefault();
		if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
	});
}

export function registerWindowIpc(paths: DesktopPaths): void {
	ipcMain.handle("window:set-theme", (event, value: unknown) => {
		const target = BrowserWindow.fromWebContents(event.sender);
		const theme = parseTheme(value);
		// 主题值由页面枚举产生；无效值不改动窗口外观，避免整页重载期间的悬空调用打断启动
		if (target === null || theme === undefined) return;
		target.setBackgroundColor(windowBackgroundColor(theme));
		if (process.platform === "win32") target.setTitleBarOverlay(titleBarOverlay(theme));
	});

	ipcMain.handle("notification:show", (event, value: unknown): boolean => {
		const target = BrowserWindow.fromWebContents(event.sender);
		const payload = parseNotification(value);
		if (target === null || payload === undefined || !Notification.isSupported()) return false;
		const notification = new Notification({
			title: payload.title,
			body: payload.body,
			icon: paths.icon,
		});
		notification.on("click", () => {
			if (target.isDestroyed()) return;
			if (target.isMinimized()) target.restore();
			target.show();
			target.focus();
		});
		notification.show();
		return true;
	});
}

/** 已有实例在跑时再次双击：把焦点还给现有窗口，而不是再起一套。 */
export function focusExistingWindows(): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (window.isMinimized()) window.restore();
		window.focus();
	}
}
