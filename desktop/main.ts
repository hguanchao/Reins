import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	BrowserWindow,
	Menu,
	Notification,
	app,
	dialog,
	ipcMain,
	nativeTheme,
	shell,
} from "electron";
import { configFilePath, pluginsDir } from "#src/config/paths.ts";
import { updateUserConfigValue } from "#src/config/write-back.ts";
import { withPluginDisabled } from "#src/plugins/disabled.ts";
import { scanDeclarativePlugins } from "#src/plugins/declarative.ts";
import { parseReadyLine } from "#src/web/ready-line.ts";
import {
	canonicalWorkspacePath,
	listKnownWorkspaces,
	registerWorkspace,
	registeredWorkspace,
	unregisterWorkspace,
} from "#src/workspace/catalog.ts";
import { writeWorkspaceName } from "#src/workspace/name.ts";

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

function sameWorkspacePath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
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
		const canonical = registerWorkspace(override);
		rememberWorkspace(canonical);
		return canonical;
	}
	const previous = lastWorkspace();
	if (previous !== undefined) {
		const canonical = canonicalWorkspacePath(previous);
		const known = listKnownWorkspaces().some((path) => sameWorkspacePath(path, canonical));
		if (known) {
			rememberWorkspace(canonical);
			return canonical;
		}
		return registerWorkspace(canonical);
	}

	const fallback = join(app.getPath("userData"), "workspace");
	mkdirSync(fallback, { recursive: true });
	const canonical = registerWorkspace(fallback);
	rememberWorkspace(canonical);
	return canonical;
}

/** 界面里的「打开工作区」只负责选目录；重启服务与换页由调用方完成。 */
async function chooseWorkspace(window: BrowserWindow): Promise<string | undefined> {
	const result = await dialog.showOpenDialog(window, {
		title: "选择项目",
		defaultPath: lastWorkspace(),
		properties: ["openDirectory", "createDirectory"],
		buttonLabel: "选择",
	});
	const picked = result.filePaths[0];
	return picked !== undefined && isDirectory(picked) ? picked : undefined;
}

interface ServerStartup {
	readonly resumeSessionId?: string;
	readonly createWorkspaceTask?: boolean;
}

/** 拉起打包好的服务进程,等 stdout 上的就绪行;报错行落进拒绝理由。 */
function startServer(workspace: string, startup: ServerStartup = {}): Promise<ServerHandle> {
	return new Promise((resolveStart, rejectStart) => {
		const child = spawn(process.execPath, [join(buildDir, "server.mjs")], {
				cwd: workspace,
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					REINS_UI_DIST: uiDist,
					REINS_WORKSPACE_NAMES_FILE: workspaceNamesFile(),
					REINS_DESKTOP_RESUME_SESSION: startup.resumeSessionId ?? "",
					REINS_DESKTOP_NEW_SESSION_WORKSPACE:
						startup.createWorkspaceTask === true ? workspace : "",
				},
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
	// Windows 的 toast 需要与安装包 appId 一致的 AUMID；开发模式没有快捷方式时可能不显示
	app.setAppUserModelId("com.reins.desktop");
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
	ipcMain.handle("notification:show", (event, payload: unknown) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window === null) return false;
		if (!Notification.isSupported()) return false;
		if (typeof payload !== "object" || payload === null) return false;
		const record = payload as { readonly title?: unknown; readonly body?: unknown };
		if (typeof record.title !== "string" || typeof record.body !== "string") return false;
		const title = record.title.trim().slice(0, 80);
		const body = record.body.trim().slice(0, 200);
		if (title.length === 0 || body.length === 0) return false;

		const notification = new Notification({
			title,
			body,
			icon: join(buildDir, "icon.ico"),
		});
		notification.on("click", () => {
			if (window.isDestroyed()) return;
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
		});
		notification.show();
		return true;
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
				dialog.showErrorBox("Reins 已退出", `服务进程已结束（退出码 ${code ?? "未知"}）。`);
			}
			app.quit();
		});
	};

	const restartServer = async (
		path: string,
		startup: ServerStartup,
		failureTitle: string,
		rememberAsWorkspace = true,
	): Promise<boolean> => {
		const previous = server;
		try {
			const canonical = canonicalWorkspacePath(path);
			const next = await startServer(canonical, startup);
			attachServer(next);
			previous?.child.kill();
			if (rememberAsWorkspace) rememberWorkspace(canonical);
			workspacePath = canonical;
			await window.loadURL(next.url);
			return true;
		} catch (error) {
			dialog.showErrorBox(failureTitle, error instanceof Error ? error.message : String(error));
			return false;
		}
	};

	/** 插件写盘后重启服务：先让 IPC 响应回到界面，再整页重载。 */
	const restartSoon = (failureTitle: string): void => {
		setTimeout(() => {
			void restartServer(workspacePath ?? process.cwd(), {}, failureTitle);
		}, 700);
	};

	const setPluginDisabled = (name: string, disabled: boolean): void => {
		updateUserConfigValue(
			["plugins", "disabled"],
			(current) => {
				const list = Array.isArray(current)
					? current.filter((item): item is string => typeof item === "string")
					: [];
				return [...withPluginDisabled(list, name, disabled)];
			},
			configFilePath(),
		);
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
		const wasVisible = registeredWorkspace(picked) !== undefined;
		const canonical = registerWorkspace(picked);
		const opened = await restartServer(canonical, {}, "切换项目失败");
		if (!opened && !wasVisible) unregisterWorkspace(canonical);
		return opened;
	});

	ipcMain.handle("workspace:open-session", async (_event, path: unknown, cwd: unknown, id: unknown) => {
		if (typeof cwd !== "string" || typeof id !== "string" || id.length === 0) return false;
		let target: string;
		try {
			target = typeof path === "string" ? registeredWorkspace(path) ?? "" : canonicalWorkspacePath(cwd);
		} catch {
			return false;
		}
		if (target.length === 0) return false;
		return restartServer(
			target,
			{ resumeSessionId: id },
			"切换任务失败",
			typeof path === "string",
		);
	});

	ipcMain.handle("workspace:new-task", async (_event, path: unknown) => {
		if (typeof path !== "string") return false;
		const target = registeredWorkspace(path);
		if (target === undefined) return false;
		return restartServer(target, { createWorkspaceTask: true }, "新建项目任务失败");
	});

	ipcMain.handle("workspace:remove", (_event, path: unknown) => {
		if (typeof path !== "string" || registeredWorkspace(path) === undefined) return false;
		return unregisterWorkspace(path);
	});

	// 「打开文件夹」交给系统资源管理器；失败只在界面上无感，不值得打断
	ipcMain.handle("workspace:reveal", (_event, path: unknown) => {
		const target = typeof path === "string" && isDirectory(path) ? path : workspacePath;
		if (target !== undefined) void shell.openPath(target);
	});

	ipcMain.handle("workspace:rename", (_event, path: unknown, name: unknown) => {
		if (typeof path !== "string" || typeof name !== "string" || registeredWorkspace(path) === undefined) {
			return false;
		}
		return writeWorkspaceName(workspaceNamesFile(), path, name);
	});

	// 插件管理：本地安装、启停与卸载。写盘后重启服务，让插件宿主重新装载。
	ipcMain.handle("plugins:install", async () => {
		const picked = await dialog.showOpenDialog(window, {
			title: "安装本地插件",
			properties: ["openDirectory"],
			buttonLabel: "安装",
		});
		const source = picked.filePaths[0];
		if (picked.canceled || source === undefined) return { ok: false, error: "已取消" };
		const entry = basename(source);
		if (entry.length === 0) return { ok: false, error: "请选择插件目录" };
		const target = join(pluginsDir(), entry);
		if (existsSync(target)) return { ok: false, error: "同名插件目录已存在" };
		try {
			mkdirSync(pluginsDir(), { recursive: true });
			cpSync(source, target, {
				recursive: true,
				filter: (path) => {
					const name = basename(path);
					return name !== "node_modules" && name !== ".git";
				},
			});
			const scan = scanDeclarativePlugins(pluginsDir());
			const plugin = scan.plugins.find((item) => item.root === target);
			if (plugin === undefined) {
				rmSync(target, { recursive: true, force: true });
				return { ok: false, error: "这个目录不是有效的声明式插件（缺少 plugin.json 等清单）" };
			}
			restartSoon("安装插件后重启失败");
			return { ok: true, name: plugin.name };
		} catch (error) {
			rmSync(target, { recursive: true, force: true });
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("plugins:toggle", (_event, name: unknown, disabled: unknown) => {
		if (typeof name !== "string" || name.length === 0 || typeof disabled !== "boolean") {
			return { ok: false, error: "参数无效" };
		}
		const scan = scanDeclarativePlugins(pluginsDir());
		if (!scan.plugins.some((plugin) => plugin.name === name)) {
			return { ok: false, error: "插件不存在" };
		}
		try {
			setPluginDisabled(name, disabled);
			restartSoon("更新插件状态后重启失败");
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("plugins:uninstall", (_event, name: unknown) => {
		if (typeof name !== "string" || name.length === 0) return { ok: false, error: "参数无效" };
		const directory = pluginsDir();
		const plugin = scanDeclarativePlugins(directory).plugins.find((item) => item.name === name);
		const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
		const codeFile = join(directory, `${name}.ts`);
		if (plugin === undefined && !(safeName && existsSync(codeFile))) {
			return { ok: false, error: "插件不存在" };
		}
		try {
			if (plugin !== undefined) rmSync(plugin.root, { recursive: true, force: true });
			else rmSync(codeFile, { force: true });
			setPluginDisabled(name, false);
			restartSoon("卸载插件后重启失败");
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
