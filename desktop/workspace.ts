import { dialog, ipcMain, shell, type BrowserWindow } from "electron";

import {
	canonicalWorkspacePath,
	registerWorkspace,
	registeredWorkspace,
	unregisterWorkspace,
} from "#src/workspace/catalog.ts";
import { writeWorkspaceName } from "#src/workspace/name.ts";
import { nonEmptyString, parseSessionTarget } from "#desktop/contracts.ts";
import { WORKSPACE_NAMES_FILE, type DesktopPaths } from "#desktop/paths.ts";
import { isDirectory, lastWorkspace } from "#desktop/startup-workspace.ts";
import type { ServerStartup } from "#desktop/server-launch.ts";

/**
 * 工作区的选取与重命名。
 *
 * 显示名按路径键存一张表，改名只改这张表，不碰磁盘目录名；启动目录的记忆与恢复
 * 单独放在启动模块，避免选取对话框与 IPC 夹带启动期的判断。
 */

export type SwitchServer = (
	path: string,
	startup: ServerStartup,
	failureTitle: string,
	remember?: boolean,
) => Promise<boolean>;

export function workspaceNamesFile(paths: DesktopPaths): string {
	return paths.userData(WORKSPACE_NAMES_FILE);
}

/** 界面里的「打开工作区」只负责选目录；重启服务与换页由调用方完成。 */
async function chooseWorkspace(window: BrowserWindow, paths: DesktopPaths): Promise<string | undefined> {
	const result = await dialog.showOpenDialog(window, {
		title: "选择项目",
		defaultPath: lastWorkspace(paths),
		properties: ["openDirectory", "createDirectory"],
		buttonLabel: "选择",
	});
	const picked = result.filePaths[0];
	return picked !== undefined && isDirectory(picked) ? picked : undefined;
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

	ipcMain.handle("workspace:open-session", async (_event, path: unknown, cwd: unknown, id: unknown) => {
		const session = parseSessionTarget(path, cwd, id);
		if (session === undefined) return false;
		let target: string | undefined;
		try {
			target =
				session.workspacePath === undefined
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
			session.workspacePath !== undefined,
		);
	});

	ipcMain.handle("workspace:new-task", async (_event, path: unknown) => {
		const requested = nonEmptyString(path);
		if (requested === undefined) return false;
		const target = registeredWorkspace(requested);
		if (target === undefined) return false;
		return switchTo(target, { createWorkspaceTask: true }, "新建项目任务失败");
	});

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
		return writeWorkspaceName(workspaceNamesFile(paths), requested, newName);
	});
}
