import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { canonicalWorkspacePath, listWorkspaces, registerWorkspace } from "#src/workspace/catalog.ts";
import { FALLBACK_WORKSPACE_DIR, LAST_WORKSPACE_FILE, type DesktopPaths } from "#desktop/paths.ts";

/**
 * 启动工作区的解析与记忆。
 *
 * 上次用过的目录只是一条恢复线索：项目被删除或隐藏后都不该由这条线索重新激活，
 * 否则「移除 / 删除工作区」一重启就失效。
 */

export function rememberWorkspace(paths: DesktopPaths, path: string): void {
	writeFileSync(paths.userData(LAST_WORKSPACE_FILE), JSON.stringify({ path }));
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function lastWorkspace(paths: DesktopPaths): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(paths.userData(LAST_WORKSPACE_FILE), "utf8"));
		const path = (parsed as { path?: unknown }).path;
		return typeof path === "string" && isDirectory(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

function sameWorkspacePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 启动时不弹目录框：上次用过的目录优先；没有时落在一个应用自管的空目录，
 * Agent 始终有真实 cwd，用户再从界面里打开真正的项目。打开工作区是界面动作，
 * 不该挡住启动。
 *
 * 落地目录只作 cwd，不登记进清单；只有用户明确选择或创建的工作区才进入注册表。
 */
export function resolveStartupWorkspace(paths: DesktopPaths): string {
	const fallback = paths.userData(FALLBACK_WORKSPACE_DIR);
	const override = process.env.REINS_WORKSPACE;
	if (override !== undefined && isDirectory(override)) {
		const canonical = registerWorkspace(override);
		rememberWorkspace(paths, canonical);
		return canonical;
	}
	const previous = lastWorkspace(paths);
	if (previous !== undefined) {
		const canonical = canonicalWorkspacePath(previous);
		const visible = listWorkspaces().some((path) => sameWorkspacePath(path, canonical));
		if (visible) {
			rememberWorkspace(paths, canonical);
			return canonical;
		}
	}

	mkdirSync(fallback, { recursive: true });
	return canonicalWorkspacePath(fallback);
}
