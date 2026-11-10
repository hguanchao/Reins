import { registerWorkspace, registeredWorkspace, unregisterWorkspace } from "#src/workspace/catalog.ts";
import { writeWorkspaceName } from "#src/workspace/name.ts";
import { createStandaloneDir, isStandalonePath, releaseStandaloneDir } from "#src/workspace/standalone.ts";
import type { ServerStartup } from "#desktop/server-launch.ts";

/** 独立任务用到的切换能力；注入便于脱离 Electron 独立验证编排。 */
export type StandaloneSwitch = (
	path: string,
	startup: ServerStartup,
	failureTitle: string,
) => Promise<boolean>;

export interface StandaloneTaskContext {
	readonly currentWorkspace: () => string | undefined;
	readonly switchTo: StandaloneSwitch;
	readonly namesFile: string;
}

/**
 * 「新建独立任务」编排，返回防重入的执行器。
 *
 * 两个坑都会让侧栏攒出一排空项目：切换服务进程要秒级，连点会各开一块目录，
 * 故在建期间复用同一个 Promise；已经停在独立任务里时新任务应落在同一块地，
 * 另开目录只产出孤儿空条目。
 */
export function createStandaloneTaskRunner(context: StandaloneTaskContext): () => Promise<boolean> {
	let pending: Promise<boolean> | undefined;
	const run = async (): Promise<boolean> => {
		const current = context.currentWorkspace();
		if (current !== undefined && isStandalonePath(current) && registeredWorkspace(current) !== undefined) {
			return context.switchTo(current, { createWorkspaceTask: true }, "新建独立任务失败");
		}
		let created: { readonly path: string; readonly label: string };
		try {
			created = createStandaloneDir();
		} catch {
			return false;
		}
		let canonical: string;
		try {
			canonical = registerWorkspace(created.path);
		} catch {
			releaseStandaloneDir(created.path);
			return false;
		}
		const opened = await context.switchTo(canonical, { createWorkspaceTask: true }, "新建独立任务失败");
		if (opened) {
			// 名字只是给人看的，写失败不影响任务本身
			writeWorkspaceName(context.namesFile, canonical, `独立任务 ${created.label}`);
			return true;
		}
		unregisterWorkspace(canonical);
		releaseStandaloneDir(created.path);
		return false;
	};
	return () => {
		if (pending !== undefined) return pending;
		pending = run().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}