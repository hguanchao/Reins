import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";
import { parseReadyLine } from "#src/web/ready-line.ts";

/**
 * 桌面壳的主进程。
 *
 * 只做三件事:选工作区、把打包好的服务进程拉起来(ELECTRON_RUN_AS_NODE,agent 崩溃不连累
 * 窗口)、开一个窗口加载本地界面。壳与内核之间没有 IPC——唯一的约定是子进程 stdout 上的
 * 就绪行。配置目录沿用默认的 ~/.reins:桌面版与 CLI 共享 provider 配置与会话。
 */

interface ServerHandle {
	readonly url: string;
	readonly child: ChildProcess;
}

/** 打包布局:asarUnpack 把 desktop/build 与 web/dist 原样铺在 resources/app.asar.unpacked 下。 */
const buildDir = __dirname;
const uiDist = join(buildDir, "..", "..", "web", "dist");

function rememberWorkspace(path: string): void {
	writeFileSync(join(app.getPath("userData"), "last-workspace.json"), JSON.stringify({ path }));
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function lastWorkspace(): string | undefined {
	const file = join(app.getPath("userData"), "last-workspace.json");
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const path = (parsed as { path?: unknown }).path;
		return typeof path === "string" && isDirectory(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 启动工作区。
 *
 * 参考同类产品的做法：启动时不弹目录框。上次用过的目录优先；首次启动落在一个应用自管的
 * 空工作区，Agent 始终有真实 cwd，用户再从界面里打开真正的项目。打开工作区是界面动作，
 * 不该挡住启动。
 */
function resolveStartupWorkspace(): string {
	const override = process.env.REINS_WORKSPACE;
	if (override !== undefined && isDirectory(override)) {
		rememberWorkspace(override);
		return override;
	}
	const previous = lastWorkspace();
	if (previous !== undefined) return previous;

	const fallback = join(app.getPath("userData"), "workspace");
	mkdirSync(fallback, { recursive: true });
	rememberWorkspace(fallback);
	return fallback;
}

/** 界面里的「打开工作区」只负责选目录；重启服务与换页由调用方完成。 */
async function chooseWorkspace(window: BrowserWindow): Promise<string | undefined> {
	const result = await dialog.showOpenDialog(window, {
		title: "打开工作区",
		defaultPath: lastWorkspace(),
		properties: ["openDirectory", "createDirectory"],
		buttonLabel: "打开",
	});
	const picked = result.filePaths[0];
	return picked !== undefined && isDirectory(picked) ? picked : undefined;
}

/** 拉起打包好的服务进程,等 stdout 上的就绪行;报错行落进拒绝理由。 */
function startServer(workspace: string): Promise<ServerHandle> {
	return new Promise((resolveStart, rejectStart) => {
		const child = spawn(process.execPath, [join(buildDir, "server.mjs")], {
			cwd: workspace,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REINS_UI_DIST: uiDist },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffered = "";
		const onStdout = (chunk: Buffer): void => {
			buffered += chunk.toString("utf8");
			for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				const ready = parseReadyLine(line);
				if (ready !== undefined) {
					child.stdout?.off("data", onStdout);
					resolveStart({ url: `http://127.0.0.1:${ready.port}/?token=${ready.token}`, child });
					return;
				}
			}
		};
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
		child.once("exit", (code) => rejectStart(new Error(`服务进程提前退出(exit ${code ?? "unknown"})`)));
	});
}

/** 窗口先出的 loading 页:纯内联,毫秒级可见;真就绪后由 loadURL 整页换掉。 */
const LOADING_PAGE =
	"data:text/html;charset=utf-8," +
	encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Reins</title>
<style>
	body{margin:0;background:#161616;color:#b3b3b3;font-family:"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
		height:100vh;display:flex;align-items:center;justify-content:center}
	.c{text-align:center}
	.s{width:26px;height:26px;margin:0 auto 16px;border-radius:50%;
		border:2px solid #2b2b2b;border-top-color:#f8f8f8;animation:r 0.8s linear infinite}
	p{margin:0;font-size:12.5px;letter-spacing:0.02em}
	@keyframes r{to{transform:rotate(360deg)}}
</style><div class="c"><div class="s"></div><p>正在启动 Reins</p></div>`);

type TopMenuKind = "edit" | "window" | "help" | "about";

/**
 * 顶栏四个菜单。
 *
 * 无边框窗口没有系统菜单栏，顶栏的标签各自弹出对应的原生菜单；关于面板的数据来自打包的
 * package.json。
 */
function buildMenus(): Record<TopMenuKind, Menu> {
	const templates: Record<TopMenuKind, Electron.MenuItemConstructorOptions[]> = {
		edit: [
			{ role: "undo", label: "撤销" },
			{ role: "redo", label: "重做" },
			{ type: "separator" },
			{ role: "cut", label: "剪切" },
			{ role: "copy", label: "复制" },
			{ role: "paste", label: "粘贴" },
			{ role: "selectAll", label: "全选" },
		],
		window: [
			{ role: "minimize", label: "最小化" },
			{ role: "zoom", label: "最大化" },
			{ type: "separator" },
			{ role: "close", label: "关闭" },
		],
		help: [
			{ role: "reload", label: "重新加载界面" },
			{ role: "toggleDevTools", label: "开发者工具" },
		],
		about: [{ role: "about", label: "关于 Reins" }],
	};
	return Object.fromEntries(
		Object.entries(templates).map(([kind, template]) => [kind, Menu.buildFromTemplate(template)]),
	) as Record<TopMenuKind, Menu>;
}

async function run(): Promise<void> {
	app.setAboutPanelOptions({ applicationName: "Reins", applicationVersion: app.getVersion() });
	const menus = buildMenus();
	// 菜单由顶栏标签按需弹出，不挂应用菜单：隐藏标题栏后它无处显示，Alt 也不该再唤出
	Menu.setApplicationMenu(null);
	ipcMain.handle("menu:show", (event, kind: unknown) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		const menu = typeof kind === "string" ? menus[kind as TopMenuKind] : undefined;
		if (menu !== undefined && window !== null) menu.popup({ window });
	});
	ipcMain.handle("window:minimize", (event) => {
		BrowserWindow.fromWebContents(event.sender)?.minimize();
	});
	ipcMain.handle("window:toggle-maximize", (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window === null) return;
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
	});
	ipcMain.handle("window:close", (event) => {
		BrowserWindow.fromWebContents(event.sender)?.close();
	});
	ipcMain.handle("window:is-maximized", (event) => {
		return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
	});
	ipcMain.handle("window:set-theme", (event, theme: unknown) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window === null) return;
		window.setBackgroundColor(theme === "zai-light" ? "#f8f8f8" : "#161616");
	});
	await app.whenReady();

	// 窗口先出:静态 loading 页毫秒级可见,选目录、拉服务都排在它后面,
	// 双击后的等待从「干瞪眼」变成「页内转圈」
	// 无边框窗:窗口按钮由渲染层绘制,与 ZCode 的顶栏同一套交互
	const window = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 880,
		minHeight: 600,
		title: "Reins",
		backgroundColor: "#161616",
		show: false,
		frame: false,
		webPreferences: {
			sandbox: true,
			preload: join(buildDir, "preload.cjs"),
		},
	});
	// 最大化状态要同步给渲染层:按钮图标在「最大化/还原」之间切换
	const sendMaximized = (): void => {
		if (!window.isDestroyed()) window.webContents.send("window:maximized-changed", window.isMaximized());
	};
	window.on("maximize", sendMaximized);
	window.on("unmaximize", sendMaximized);
	let server: ServerHandle | undefined;
	let serverGeneration = 0;
	let serverOrigin: string | undefined;

	const attachServer = (handle: ServerHandle): void => {
		const generation = ++serverGeneration;
		server = handle;
		serverOrigin = new URL(handle.url).origin;
		handle.child.once("exit", (code) => {
			// 切换工作区时旧进程会被主动结束，它的退出不该被当成崩溃
			if (generation !== serverGeneration) return;
			if (!window.isDestroyed()) {
				dialog.showErrorBox("Reins 已退出", `服务进程结束(exit ${code ?? "unknown"})。`);
			}
			app.quit();
		});
	};

	window.on("closed", () => {
		// 窗口是壳的唯一出口:关窗即收摊,服务进程跟着退
		server?.child.kill();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith("http://127.0.0.1:")) void shell.openExternal(url);
		return { action: "deny" };
	});
	// 页面里的外链不能把壳导航走；同源路由放行，其余交给系统浏览器
	window.webContents.on("will-navigate", (event, url) => {
		if (serverOrigin !== undefined && url.startsWith(serverOrigin)) return;
		event.preventDefault();
		if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
	});

	ipcMain.handle("workspace:choose", async () => {
		const picked = await chooseWorkspace(window);
		if (picked === undefined) return false;

		const previous = server;
		try {
			const next = await startServer(picked);
			attachServer(next);
			previous?.child.kill();
			rememberWorkspace(picked);
			await window.loadURL(next.url);
			return true;
		} catch (error) {
			dialog.showErrorBox("切换工作区失败", error instanceof Error ? error.message : String(error));
			return false;
		}
	});

	await window.loadURL(LOADING_PAGE);
	window.show();

	let workspace: string;
	try {
		workspace = resolveStartupWorkspace();
	} catch (error) {
		dialog.showErrorBox("Reins 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
		return;
	}

	try {
		const handle = await startServer(workspace);
		attachServer(handle);
		// 就绪行到了,整页换成真正的界面
		await window.loadURL(handle.url);
	} catch (error) {
		dialog.showErrorBox("Reins 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
	}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		// 已有实例在跑时再次双击:把焦点还给现有窗口,而不是再起一套
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.isMinimized()) window.restore();
			window.focus();
		}
	});
	void run();
}
