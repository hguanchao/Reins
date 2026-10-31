import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function lastWorkspace(): string | undefined {
	const file = join(app.getPath("userData"), "last-workspace.json");
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const path = (parsed as { path?: unknown }).path;
		return typeof path === "string" && existsSync(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

/** 原生对话框选工作区,挂在启动窗口上;默认落在上次用过的目录。取消选择就退出——没有工作区,agent 无处安身。 */
async function pickWorkspace(window: BrowserWindow): Promise<string | undefined> {
	// 环境变量入口:测试与自动化用它跳过对话框;存在且有效才认
	const override = process.env.REINS_WORKSPACE;
	if (override !== undefined && existsSync(override)) {
		rememberWorkspace(override);
		return override;
	}
	const previous = lastWorkspace();
	const result = await dialog.showOpenDialog(window, {
		title: "选择 Reins 的工作区",
		defaultPath: previous,
		properties: ["openDirectory", "createDirectory"],
		buttonLabel: "在这里工作",
	});
	const picked = result.filePaths[0];
	if (picked === undefined) return undefined;
	rememberWorkspace(picked);
	return picked;
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
	body{margin:0;background:#121212;color:#8a8a8a;font-family:"Segoe UI",system-ui,sans-serif;
		height:100vh;display:flex;align-items:center;justify-content:center}
	.c{text-align:center}
	.s{width:34px;height:34px;margin:0 auto 14px;border-radius:50%;
		border:3px solid #2c2c2c;border-top-color:#d78a4e;animation:r 0.9s linear infinite}
	p{font-size:13px;letter-spacing:1px}
	@keyframes r{to{transform:rotate(360deg)}}
</style><div class="c"><div class="s"></div><p>Reins 启动中…</p></div>`);

/** 四个顶级菜单;无边框窗的菜单条点击时在按钮原位弹出,保持真正的原生菜单交互。 */
function buildMenus(): Record<string, Menu> {
	const templates: Record<string, Electron.MenuItemConstructorOptions[]> = {
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
	);
}

async function run(): Promise<void> {
	// 原生菜单栏:编辑/窗口/帮助/关于,标签带 Alt 访问键;关于面板的数据来自打包的 package.json
	app.setAboutPanelOptions({ applicationName: "Reins", applicationVersion: app.getVersion() });
	const menus = buildMenus();
	// 菜单改为页内菜单条弹出,不再挂应用菜单:隐藏标题栏后它无处显示,Alt 也不该再唤出
	Menu.setApplicationMenu(null);
	ipcMain.handle("menu:show", (event, kind: unknown) => {
		const menu = typeof kind === "string" ? menus[kind] : undefined;
		const window = BrowserWindow.fromWebContents(event.sender);
		if (menu !== undefined && window !== null) menu.popup({ window });
	});
	await app.whenReady();

	// 窗口先出:静态 loading 页毫秒级可见,选目录、拉服务都排在它后面,
	// 双击后的等待从「干瞪眼」变成「页内转圈」
	// 无边框窗:菜单条本身是最顶行,最小化/最大化/关闭由 titleBarOverlay 的原生按钮承担
	const window = new BrowserWindow({
		width: 1180,
		height: 820,
		title: "Reins",
		backgroundColor: "#ffffff",
		show: false,
		titleBarStyle: "hidden",
		titleBarOverlay: { color: "#ffffff", symbolColor: "#262626", height: 36 },
		webPreferences: {
			sandbox: true,
			preload: join(buildDir, "preload.cjs"),
		},
	});
	let server: ServerHandle | undefined;
	window.on("closed", () => {
		// 窗口是壳的唯一出口:关窗即收摊,服务进程跟着退
		server?.child.kill();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith("http://127.0.0.1:")) void shell.openExternal(url);
		return { action: "deny" };
	});
	await window.loadURL(LOADING_PAGE);
	window.show();

	// 原生对话框挂在工作窗口上,模态而不再挡住整个启动
	const workspace = await pickWorkspace(window);
	if (workspace === undefined) {
		app.quit();
		return;
	}

	try {
		server = await startServer(workspace);
	} catch (error) {
		dialog.showErrorBox("Reins 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
		return;
	}
	server.child.once("exit", (code) => {
		if (!window.isDestroyed()) {
			dialog.showErrorBox("Reins 已退出", `服务进程结束(exit ${code ?? "unknown"})。`);
		}
		app.quit();
	});

	// 就绪行到了,整页换成真正的界面
	await window.loadURL(server.url);
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
