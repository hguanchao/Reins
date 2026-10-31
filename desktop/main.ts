import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, app, dialog, shell } from "electron";
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

/** 原生对话框选工作区;默认落在上次用过的目录。取消选择就退出——没有工作区,agent 无处安身。 */
async function pickWorkspace(): Promise<string | undefined> {
	// 环境变量入口:测试与自动化用它跳过对话框;存在且有效才认
	const override = process.env.REINS_WORKSPACE;
	if (override !== undefined && existsSync(override)) {
		rememberWorkspace(override);
		return override;
	}
	const previous = lastWorkspace();
	const result = await dialog.showOpenDialog({
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

async function run(): Promise<void> {
	Menu.setApplicationMenu(null);
	await app.whenReady();

	const workspace = await pickWorkspace();
	if (workspace === undefined) {
		app.quit();
		return;
	}

	let server: ServerHandle;
	try {
		server = await startServer(workspace);
	} catch (error) {
		dialog.showErrorBox("Reins 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
		return;
	}

	const window = new BrowserWindow({
		width: 1180,
		height: 820,
		title: "Reins",
		backgroundColor: "#121212",
		webPreferences: { sandbox: true },
	});
	window.on("closed", () => {
		// 窗口是壳的唯一出口:关窗即收摊,服务进程跟着退
		server.child.kill();
	});
	server.child.once("exit", (code) => {
		if (!window.isDestroyed()) {
			dialog.showErrorBox("Reins 已退出", `服务进程结束(exit ${code ?? "unknown"})。`);
		}
		app.quit();
	});

	// 界面里的外链交给系统浏览器,不要在壳里开新窗
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith("http://127.0.0.1:")) void shell.openExternal(url);
		return { action: "deny" };
	});
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
