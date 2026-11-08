import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dialog, ipcMain, shell, type BrowserWindow } from "electron";

import {
	canonicalWorkspacePath,
	listKnownWorkspaces,
	registerWorkspace,
	registeredWorkspace,
	unregisterWorkspace,
} from "#src/workspace/catalog.ts";
import { writeWorkspaceName } from "#src/workspace/name.ts";
import { nonEmptyString, parseSessionTarget } from "#desktop/contracts.ts";
import { LAST_WORKSPACE_FILE, WORKSPACE_NAMES_FILE, type DesktopPaths } from "#desktop/paths.ts";
import type { ServerStartup } from "#desktop/server-launch.ts";

/**
 * 工作区的选取、记忆与重命名。
 *
 * 显示名按路径键存一张表，改名只改这张表，不碰磁盘目录名；上次用过的目录记在
 * userData，切换与恢复会话都要先确认它仍在已登记表里。
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

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function sameWorkspacePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function rememberWorkspace(paths: DesktopPaths, path: string): void {
	writeFileSync(paths.userData(LAST_WORKSPACE_FILE), JSON.stringify({ path }));
}

function lastWorkspace(paths: DesktopPaths): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(paths.userData(LAST_WORKSPACE_FILE), "utf8"));
		const path = (parsed as { path?: unknown }).path;
		return typeof path === "string" && isDirectory(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 启动时不弹目录框：上次用过的目录优先；首次启动落在一个应用自管的空工作区，
 * Agent 始终有真实 cwd，用户再从界面里打开真正的项目。打开工作区是界面动作，
 * 不该挡住启动。
 */
export function resolveStartupWorkspace(paths: DesktopPaths): string {
	const override = process.env.REINS_WORKSPACE;
	if (override !== undefined && isDirectory(override)) {
		const canonical = registerWorkspace(override);
		rememberWorkspace(paths, canonical);
		return canonical;
	}
	const previous = lastWorkspace(paths);
	if (previous !== undefined) {
		const canonical = canonicalWorkspacePath(previous);
		const known = listKnownWorkspaces().some((path) => sameWorkspacePath(path, canonical));
		if (known) {
			rememberWorkspace(paths, canonical);
			return canonical;
		}
		return registerWorkspace(canonical);
	}

	const fallback = paths.userData("workspace");
	mkdirSync(fallback, { recursive: true });
	const canonical = registerWorkspace(fallback);
	rememberWorkspace(paths, canonical);
	return canonical;
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
