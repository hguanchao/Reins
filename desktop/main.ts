import { app, dialog, Menu, nativeTheme } from "electron";

import { registerPluginIpc } from "#desktop/plugins.ts";
import { createDesktopPaths } from "#desktop/paths.ts";
import { ServerController } from "#desktop/server-controller.ts";
import { themeFromSystem } from "#desktop/theme.ts";
import {
	createMainWindow,
	focusExistingWindows,
	HIDDEN_MENU,
	installNavigationGuards,
	loadingPage,
	registerWindowIpc,
} from "#desktop/window.ts";
import { registerWorkspaceIpc, rememberWorkspace, resolveStartupWorkspace } from "#desktop/workspace.ts";

/**
 * 桌面壳入口。
 *
 * 只做编排：装配窗口、服务进程与各组 IPC，然后把启动工作区交给控制器。壳与内核之间
 * 没有业务 IPC——唯一的约定是子进程 stdout 上的就绪行。配置目录沿用默认的 ~/.reins，
 * 桌面版与 CLI 共享 provider 配置与会话。
 */
async function run(): Promise<void> {
	app.setAboutPanelOptions({ applicationName: "Reins", applicationVersion: app.getVersion() });
	Menu.setApplicationMenu(HIDDEN_MENU);
	// Windows 的 toast 需要与安装包 appId 一致的 AUMID。开发模式没有同 ID 的快捷方式，
	// 设了反而会让任务栏回退到 electron.exe 的图标，所以只在打包后设置。
	if (app.isPackaged) app.setAppUserModelId("com.reins.desktop");
	await app.whenReady();

	const paths = createDesktopPaths(__dirname, app.getPath("userData"));
	const window = createMainWindow(paths, themeFromSystem(nativeTheme.shouldUseDarkColors));
	const controller = new ServerController(window, paths, {
		onCrash: (reason) => {
			if (!window.isDestroyed()) dialog.showErrorBox("Reins 已退出", reason);
			app.quit();
		},
		onFailure: (title, message) => dialog.showErrorBox(title, message),
		rememberWorkspace: (path) => rememberWorkspace(paths, path),
	});

	// 窗口是壳的唯一出口：关窗即收摊，服务进程跟着退
	window.on("closed", () => controller.shutdown());
	installNavigationGuards(window, () => controller.origin);
	registerWindowIpc(paths);
	registerWorkspaceIpc({
		window,
		paths,
		switchTo: (path, startup, title, remember) => controller.switchTo(path, startup, title, remember),
		currentWorkspace: () => controller.workspace,
	});
	registerPluginIpc({
		window,
		restartSoon: (title) => controller.restartSoon(title),
	});

	// 静态 loading 页毫秒级可见，选目录、拉服务都排在它后面
	await window.loadURL(loadingPage());
	window.show();

	let workspace: string;
	try {
		workspace = resolveStartupWorkspace(paths);
	} catch (error) {
		dialog.showErrorBox("Reins 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
		return;
	}
	const started = await controller.switchTo(workspace, {}, "Reins 启动失败");
	if (!started) app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", focusExistingWindows);
	void run();
}
