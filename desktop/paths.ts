import { join } from "node:path";

/**
 * 打包布局。
 *
 * asarUnpack 把 desktop/build 与 web/dist 原样铺在 resources/app.asar.unpacked 下，
 * 因此所有运行期资源都以主进程所在目录为基准推算，不依赖进程当前工作目录。
 */

export interface DesktopPaths {
	readonly buildDir: string;
	readonly uiDist: string;
	readonly serverEntry: string;
	readonly preload: string;
	readonly icon: string;
	/** userData 目录下的文件名 → 绝对路径。 */
	userData(name: string): string;
}

export const LAST_WORKSPACE_FILE = "last-workspace.json";
export const LAST_PICKED_WORKSPACE_FILE = "last-picked-workspace.json";
/** 启动落地的自管空目录：只作服务进程的 cwd，永远不算用户项目。 */
export const FALLBACK_WORKSPACE_DIR = "workspace";

export function createDesktopPaths(buildDir: string, userDataDir: string): DesktopPaths {
	return {
		buildDir,
		uiDist: join(buildDir, "..", "..", "web", "dist"),
		serverEntry: join(buildDir, "server.mjs"),
		preload: join(buildDir, "preload.cjs"),
		icon: join(buildDir, "icon.ico"),
		userData: (name) => join(userDataDir, name),
	};
}
