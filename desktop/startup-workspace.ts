import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import {
	canonicalWorkspacePath,
	dropWorkspace,
	listWorkspaces,
	registerWorkspace,
} from "#src/workspace/catalog.ts";
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
 * 落地目录只是 cwd，不是用户项目：不登记进清单，否则侧栏会凭空多出一个
 * 默认「workspace」项目，重启还会被记忆恢复成当前项目。
 */
export function resolveStartupWorkspace(paths: DesktopPaths): string {
	const fallback = paths.userData(FALLBACK_WORKSPACE_DIR);
	// 旧版本曾把落地目录误登记成可见项目；启动时统一清掉这条错误登记，
	// 内核的会话扫描也经环境变量认得它，不会再补回来。
	dropWorkspace(fallback);
	const override = process.env.REINS_WORKSPACE;
	if (override !== undefined && isDirectory(override)) {
		const canonical = registerWorkspace(override);
		rememberWorkspace(paths, canonical);
		return canonical;
	}
	const previous = lastWorkspace(paths);
	if (previous !== undefined) {
		const canonical = canonicalWorkspacePath(previous);
		// 只认仍可见的项目：从侧栏移除的条目还留在清单里供历史任务查找，
		// 但不该再被当成默认工作目录，否则「移除」之后应用仍旧在那个目录开工。
		const visible = listWorkspaces().some((path) => sameWorkspacePath(path, canonical));
		if (visible) {
			rememberWorkspace(paths, canonical);
			return canonical;
		}
		// 记忆指向已删除或已移除的项目：不复活它，继续落到自管空工作区；启动成功后
		// 控制器还会把这条过期记忆改写成新目录。
	}

	mkdirSync(fallback, { recursive: true });
	return canonicalWorkspacePath(fallback);
}
