import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell } from "electron";
import { parseReadyLine } from "#src/web/ready-line.ts";
import { workspaceNameOf, writeWorkspaceName } from "#src/workspace/name.ts";

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

/** 工作区显示名按路径键存一张表;重命名只改这张表,不碰磁盘目录名。 */
function workspaceNamesFile(): string {
	return join(app.getPath("userData"), "workspace-names.json");
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

/**
 * 窗口先出的 loading 页:纯内联,毫秒级可见;真就绪后由 loadURL 整页换掉。
 * 底色跟随系统,默认主题跟随系统时首屏不会先闪一下深色。
 */
const LOADING_PAGE =
	"data:text/html;charset=utf-8," +
	encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Reins</title>
<style>
	body{margin:0;background:#f9fafb;color:#61666b;font-family:"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
		height:100vh;display:flex;align-items:center;justify-content:center}
	.c{text-align:center}
	.s{width:24px;height:24px;margin:0 auto 14px;border-radius:50%;
		border:2px solid #e5e7eb;border-top-color:#0f1115;animation:r 0.8s linear infinite}
	p{margin:0;font-size:13px;letter-spacing:0.02em}
	@keyframes r{to{transform:rotate(360deg)}}
	@media (prefers-color-scheme: dark){
		body{background:#151517;color:#81858c}
		.s{border-color:#2c2c2e;border-top-color:#f9fafb}
	}
</style><div class="c"><div class="s"></div><p>正在启动 Reins</p></div>`);

/**
 * 隐藏的应用菜单。
 *
 * 无边框窗口没有菜单栏,界面也不提供菜单入口;这里只挂重载与开发者工具两个 role,
 * 让它们的快捷键(Ctrl+R / F12 类)继续生效,菜单本身永远不显示。
 */
const HIDDEN_MENU = Menu.buildFromTemplate([
	{
		label: "界面",
		submenu: [
			{ role: "reload", label: "重新加载界面" },
			{ role: "toggleDevTools", label: "开发者工具" },
		],
	},
]);

async function run(): Promise<void> {
	app.setAboutPanelOptions({ applicationName: "Reins", applicationVersion: app.getVersion() });
	// 菜单不显示,只为保住重载/开发者工具的快捷键
	Menu.setApplicationMenu(HIDDEN_MENU);
	ipcMain.handle("window:set-theme", (event, theme: unknown) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window === null) return;
		const dark = theme === "zai-dark";
		window.setBackgroundColor(dark ? "#151517" : "#f9fafb");
		if (process.platform === "win32") {
			window.setTitleBarOverlay({
				color: dark ? "#1b1b1c" : "#f9fafb",
				symbolColor: dark ? "#f9fafb" : "#0f1115",
				height: 40,
			});
		}
	});
	await app.whenReady();

	// 窗口先出:静态 loading 页毫秒级可见,选目录、拉服务都排在它后面,
	// 双击后的等待从「干瞪眼」变成「页内转圈」
	// 无边框窗：Windows 用原生标题栏覆盖层保留系统窗控，页面只负责 40px 拖拽条
	const window = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 880,
		minHeight: 600,
		title: "Reins",
		icon: join(buildDir, "icon.ico"),
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#151517" : "#f9fafb",
		show: false,
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		...(process.platform === "win32"
			? {
					titleBarOverlay: {
						color: nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#f9fafb",
						symbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115",
						height: 40,
					},
				}
			: {}),
		webPreferences: {
			sandbox: true,
			preload: join(buildDir, "preload.cjs"),
		},
	});
let server: ServerHandle | undefined;
let serverGeneration = 0;
let serverOrigin: string | undefined;
/** 当前服务所在的工作区路径；「打开文件夹」用它 */
let workspacePath: string | undefined;

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
			workspacePath = picked;
			await window.loadURL(next.url);
			return true;
		} catch (error) {
			dialog.showErrorBox("切换工作区失败", error instanceof Error ? error.message : String(error));
			return false;
		}
	});

	// 「打开文件夹」交给系统资源管理器；失败只在界面上无感，不值得打断
	ipcMain.handle("workspace:reveal", () => {
		if (workspacePath !== undefined) void shell.openPath(workspacePath);
	});

	// 工作区在侧栏里的显示名;与路径分开存,重命名不改磁盘上的目录
	ipcMain.handle("workspace:name", () => workspaceNameOf(workspaceNamesFile(), workspacePath));

	ipcMain.handle("workspace:rename", (_event, name: unknown) => {
		if (typeof name !== "string" || workspacePath === undefined) return false;
		return writeWorkspaceName(workspaceNamesFile(), workspacePath, name);
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
	workspacePath = workspace;

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
