import { spawn } from "node:child_process";

import { parseReadyLine } from "#src/web/ready-line.ts";
import { FALLBACK_WORKSPACE_DIR, type DesktopPaths } from "#desktop/paths.ts";

/**
 * 拉起打包好的服务进程。
 *
 * 壳与内核之间只有一条约定：子进程 stdout 上的就绪行。启动阶段必须自己兜住超时、
 * 提前退出与异常输出，否则窗口会永远停在 loading 页；就绪之后 stderr 仍持续转发，
 * 但启动期的 exit 监听要摘掉，交给生命周期控制器判断是不是崩溃。
 */

/** 控制器只关心进程的退出监听与终止，不必认识 ChildProcess 的全套能力。 */
export interface ServerProcess {
	once(event: "exit", listener: (code: number | null) => void): unknown;
	kill(): boolean;
}

export interface ServerHandle {
	readonly url: string;
	readonly child: ServerProcess;
}

export interface ServerStartup {
	readonly resumeSessionId?: string;
	readonly createWorkspaceTask?: boolean;
}

const START_TIMEOUT_MS = 30_000;
const MAX_READY_BUFFER = 64 * 1024;
const STDERR_TAIL = 4 * 1024;

export function startServer(
	paths: DesktopPaths,
	workspace: string,
	startup: ServerStartup = {},
	timeoutMs: number = START_TIMEOUT_MS,
): Promise<ServerHandle> {
	return new Promise((resolveStart, rejectStart) => {
		const child = spawn(process.execPath, [paths.serverEntry], {
			cwd: workspace,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				REINS_UI_DIST: paths.uiDist,
				// 落地目录不是项目：内核按会话重建清单时跳过它，免得默认项目复活
				REINS_FALLBACK_WORKSPACE: paths.userData(FALLBACK_WORKSPACE_DIR),
				REINS_DESKTOP_RESUME_SESSION: startup.resumeSessionId ?? "",
				REINS_DESKTOP_NEW_SESSION_WORKSPACE: startup.createWorkspaceTask === true ? workspace : "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffered = "";
		let stderrTail = "";
		let settled = false;
		const timer = setTimeout(() => fail("服务进程启动超时，未收到就绪行"), timeoutMs);

		function cleanup(): void {
			clearTimeout(timer);
			child.stdout?.off("data", onStdout);
			child.off("exit", onEarlyExit);
		}

		function fail(message: string): void {
			if (settled) return;
			settled = true;
			cleanup();
			child.kill();
			rejectStart(new Error(message));
		}

		function succeed(handle: ServerHandle): void {
			if (settled) return;
			settled = true;
			cleanup();
			resolveStart(handle);
		}

		function onStdout(chunk: Buffer): void {
			buffered += chunk.toString("utf8");
			if (buffered.length > MAX_READY_BUFFER) {
				fail("服务进程输出异常：就绪行之前的数据过长");
				return;
			}
			for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				const ready = parseReadyLine(line);
				if (ready !== undefined) {
					succeed({ url: `http://127.0.0.1:${ready.port}/?token=${ready.token}`, child });
					return;
				}
			}
		}

		function onStderr(chunk: Buffer): void {
			process.stderr.write(chunk);
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
		}

		function onEarlyExit(code: number | null): void {
			const detail = stderrTail.trim();
			fail(`服务进程提前退出（退出码 ${code ?? "未知"}）${detail.length === 0 ? "" : `：${detail}`}`);
		}

		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.once("exit", onEarlyExit);
	});
}
