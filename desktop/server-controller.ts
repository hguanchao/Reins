import { canonicalWorkspacePath } from "#src/workspace/catalog.ts";
import type { DesktopPaths } from "#desktop/paths.ts";
import { startServer, type ServerHandle, type ServerStartup } from "#desktop/server-launch.ts";

/**
 * 服务进程的生命周期。
 *
 * 切换工作区、恢复会话、插件启停都要换进程。这里的规则是：新进程就绪且新页面加载成功
 * 才算提交，否则整步回滚（杀掉新进程、旧进程继续服务）；并发请求排队串行，不会同时拉起
 * 两个服务进程；被主动替换的旧进程退出不算崩溃。
 */

/** 控制器只用到窗口的这两个能力，便于独立验证切换逻辑。 */
export interface HostWindow {
	loadURL(url: string): Promise<void>;
}

export interface ControllerHooks {
	onCrash(reason: string): void;
	onFailure(title: string, message: string): void;
	rememberWorkspace(path: string): void;
}

export type ServerLauncher = (workspace: string, startup: ServerStartup) => Promise<ServerHandle>;

/** 让 IPC 的返回值先回到页面，再整页重载；延迟只服务这一点。 */
const RESTART_DELAY_MS = 250;

export class ServerController {
	private readonly window: HostWindow;
	private readonly hooks: ControllerHooks;
	private readonly launch: ServerLauncher;
	private current: ServerHandle | undefined;
	private generation = 0;
	private queue: Promise<void> = Promise.resolve();
	private originValue: string | undefined;
	private workspaceValue: string | undefined;

	constructor(
		window: HostWindow,
		paths: DesktopPaths,
		hooks: ControllerHooks,
		launch: ServerLauncher = (workspace, startup) => startServer(paths, workspace, startup),
	) {
		this.window = window;
		this.hooks = hooks;
		this.launch = launch;
	}

	get origin(): string | undefined {
		return this.originValue;
	}

	get workspace(): string | undefined {
		return this.workspaceValue;
	}

	/** 排队串行：前一个失败也不阻断后一个，队列本身始终可继续。 */
	private serialize(task: () => Promise<boolean>): Promise<boolean> {
		const result = this.queue.then(task, task);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	switchTo(
		path: string,
		startup: ServerStartup,
		failureTitle: string,
		remember: boolean = true,
	): Promise<boolean> {
		return this.serialize(() => this.apply(path, startup, failureTitle, remember));
	}

	/** 插件写盘后重启：延后一拍，避免整页重载吞掉 IPC 的返回值。 */
	restartSoon(failureTitle: string): void {
		setTimeout(() => {
			const path = this.workspaceValue;
			if (path !== undefined) void this.switchTo(path, {}, failureTitle, false);
		}, RESTART_DELAY_MS);
	}

	shutdown(): void {
		this.current?.child.kill();
	}

	private async apply(
		path: string,
		startup: ServerStartup,
		failureTitle: string,
		remember: boolean,
	): Promise<boolean> {
		let next: ServerHandle | undefined;
		try {
			const canonical = canonicalWorkspacePath(path);
			next = await this.launch(canonical, startup);
			// 新页面加载成功之前不碰旧进程，失败时只需把新进程收掉
			await this.window.loadURL(next.url);

			const previous = this.current;
			this.generation += 1;
			this.current = next;
			this.originValue = new URL(next.url).origin;
			this.workspaceValue = canonical;
			if (remember) this.hooks.rememberWorkspace(canonical);
			this.watch(next, this.generation);
			previous?.child.kill();
			return true;
		} catch (error) {
			next?.child.kill();
			this.hooks.onFailure(failureTitle, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	private watch(handle: ServerHandle, generation: number): void {
		handle.child.once("exit", (code) => {
			// 切换工作区时旧进程被主动结束，它的退出不该被当成崩溃
			if (generation !== this.generation) return;
			this.hooks.onCrash(`服务进程已结束（退出码 ${code ?? "未知"}）。`);
		});
	}
}
