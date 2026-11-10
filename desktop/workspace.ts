import { readFileSync, writeFileSync } from "node:fs";

import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";

import {
	canonicalWorkspacePath,
	dropWorkspace,
	registerWorkspace,
	registeredWorkspace,
	renameWorkspace,
	unregisterWorkspace,
} from "#src/workspace/catalog.ts";
import { createStandaloneDir, releaseStandaloneDir } from "#src/workspace/standalone.ts";
import { nonEmptyString, parseSessionTarget, parseWorkspaceName } from "#desktop/contracts.ts";
import type { WorkspaceCreationResult } from "#desktop/contracts.ts";
import { LAST_PICKED_WORKSPACE_FILE, type DesktopPaths } from "#desktop/paths.ts";
import { createStandaloneTaskRunner, defaultUnboundDir } from "#desktop/standalone-task.ts";
import { isDirectory } from "#desktop/startup-workspace.ts";
import type { ServerStartup } from "#desktop/server-launch.ts";

/**
 * 工作区的选取与重命名。
 *
 * 显示名与登记状态统一写入工作区注册表，不碰磁盘目录名；启动目录的记忆与恢复
 * 单独放在启动模块，避免选取对话框与 IPC 夹带启动期的判断。
 */

export type SwitchServer = (
	path: string,
	startup: ServerStartup,
	failureTitle: string,
	remember?: boolean,
) => Promise<boolean>;

function lastPickedWorkspace(paths: DesktopPaths): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(paths.userData(LAST_PICKED_WORKSPACE_FILE), "utf8"));
		const path = (parsed as { path?: unknown }).path;
		return typeof path === "string" && isDirectory(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

function rememberPickedWorkspace(paths: DesktopPaths, path: string): void {
	writeFileSync(paths.userData(LAST_PICKED_WORKSPACE_FILE), JSON.stringify({ path }));
}

/** 界面里的「打开工作区」只负责选目录；重启服务与换页由调用方完成。 */
async function chooseWorkspace(window: BrowserWindow, paths: DesktopPaths): Promise<string | undefined> {
	const result = await dialog.showOpenDialog(window, {
		title: "选择项目",
		defaultPath: lastPickedWorkspace(paths) ?? app.getPath("documents"),
		properties: ["openDirectory", "createDirectory"],
		buttonLabel: "选择",
	});
	const picked = result.filePaths[0];
	if (picked === undefined || !isDirectory(picked)) return undefined;
	rememberPickedWorkspace(paths, picked);
	return picked;
}

export interface WorkspaceIpcContext {
	readonly window: BrowserWindow;
	readonly paths: DesktopPaths;
	readonly switchTo: SwitchServer;
	/** 「打开文件夹」在未给路径时退回当前服务所在的工作区。 */
	readonly currentWorkspace: () => string | undefined;
}

export function registerWorkspaceIpc(context: WorkspaceIpcContext): void {
	const { window, paths, switchTo } = context;

	ipcMain.handle("workspace:choose", async () => {
		const picked = await chooseWorkspace(window, paths);
		if (picked === undefined) return false;
		const wasVisible = registeredWorkspace(picked) !== undefined;
		const canonical = registerWorkspace(picked);
		const opened = await switchTo(canonical, {}, "切换项目失败");
		if (!opened && !wasVisible) unregisterWorkspace(canonical);
		return opened;
	});

	// 「从侧栏移除」只翻可见性：会话文件一个不动，隐藏路径仍供历史任务扫描，
	// 与「删除项目」连任务一起永久移除是两回事，界面必须分开给动作
	ipcMain.handle("workspace:hide", (_event, path: unknown) => {
		const requested = nonEmptyString(path);
		return requested === undefined ? false : unregisterWorkspace(requested);
	});

	// 新建工作空间：项目目录以 standalone- 时间戳命名，用户填写的名称保存在注册表显示名中。
	// 项目目录与 JSONL 会话同处 sessions/，看到目录名即可识别其由 Reins 管理。
	ipcMain.handle("workspace:create", async (_event, name: unknown): Promise<WorkspaceCreationResult> => {
		const requested = parseWorkspaceName(name);
		if (requested === undefined) {
			return { ok: false, error: "名称不能为空、超过 60 字，或含有路径分隔符与非法字符" };
		}
		let target: string | undefined;
		try {
			target = createStandaloneDir().path;
			const canonical = registerWorkspace(target, "created", requested);
			const opened = await switchTo(canonical, {}, "新建工作空间失败");
			if (opened) return { ok: true };
			dropWorkspace(canonical);
			releaseStandaloneDir(canonical);
			return { ok: false, error: "工作空间已建好，但切换失败，请重试" };
		} catch {
			if (target !== undefined) releaseStandaloneDir(target);
			return { ok: false, error: "无法创建工作空间目录" };
		}
	});

	ipcMain.handle("workspace:open-session", async (_event, path: unknown, cwd: unknown, id: unknown) => {
		const session = parseSessionTarget(path, cwd, id);
		if (session === undefined) return false;
		let target: string | undefined;
		try {
			target =
				session.workspacePath === null
					? canonicalWorkspacePath(session.cwd)
					: registeredWorkspace(session.workspacePath);
		} catch {
			return false;
		}
		if (target === undefined || target.length === 0) return false;
		return switchTo(
			target,
			{ resumeSessionId: session.id },
			"切换任务失败",
			session.workspacePath !== null,
		);
	});

	ipcMain.handle("workspace:new-task", async (_event, path: unknown) => {
		const requested = nonEmptyString(path);
		if (requested === undefined) return false;
		const target = registeredWorkspace(requested);
		if (target === undefined) return false;
		return switchTo(target, { createWorkspaceTask: true }, "新建项目任务失败");
	});

	// 「新建任务」：给没有项目的任务一块自管空地。空地不登记成项目——侧栏不为它长出
	// 工作区分组，会话按未归属任务出现在「任务」区，点开仍需先选工作区
	ipcMain.handle(
		"workspace:new-standalone",
		createStandaloneTaskRunner({
			unboundDir: defaultUnboundDir,
			switchTo,
		}),
	);

	// 「删除项目」不在这里：任务归属与当前会话的让位只有内核判得准，界面直接走 /api/workspaces/delete
	// 「打开文件夹」交给系统资源管理器；失败只在界面上无感，不值得打断
	ipcMain.handle("workspace:reveal", (_event, path: unknown) => {
		const target = typeof path === "string" && isDirectory(path) ? path : context.currentWorkspace();
		if (target !== undefined) void shell.openPath(target);
	});

	ipcMain.handle("workspace:rename", (_event, path: unknown, name: unknown) => {
		const requested = nonEmptyString(path);
		const newName = nonEmptyString(name);
		if (requested === undefined || newName === undefined || registeredWorkspace(requested) === undefined) {
			return false;
		}
		return renameWorkspace(requested, newName);
	});
}
