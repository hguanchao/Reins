import { createStandaloneDir, releaseStandaloneDir } from "#src/workspace/standalone.ts";
import type { ServerStartup } from "#desktop/server-launch.ts";

/** 独立任务用到的切换能力；注入便于脱离 Electron 独立验证编排。 */
export type StandaloneSwitch = (
	path: string,
	startup: ServerStartup,
	failureTitle: string,
) => Promise<boolean>;

export interface StandaloneTaskContext {
	/** 新任务落脚的自管空地：新建一块目录，不登记进项目清单。 */
	readonly unboundDir: () => string;
	readonly switchTo: StandaloneSwitch;
}

/**
 * 「新建任务」编排，返回防重入的执行器。
 *
 * 新任务只落一块自管空地，不登记成工作区：侧栏不该为它长出项目分组，
 * 会话本身按未归属任务出现在「任务」区。切换服务进程要秒级，连点会各开一块目录，
 * 所以在建期间复用同一个 Promise。
 */
export function createStandaloneTaskRunner(context: StandaloneTaskContext): () => Promise<boolean> {
	let pending: Promise<boolean> | undefined;
	const run = async (): Promise<boolean> => {
		let root: string;
		try {
			root = context.unboundDir();
		} catch {
			return false;
		}
		const opened = await context.switchTo(root, {}, "新建任务失败");
		// 切换失败时收回刚建的空地，别在配置目录里攒空目录
		if (!opened) releaseStandaloneDir(root);
		return opened;
	};
	return () => {
		if (pending !== undefined) return pending;
		pending = run().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}

/** 默认的空地来源：配置目录 workspaces 下按时刻建目录。 */
export function defaultUnboundDir(): string {
	return createStandaloneDir().path;
}