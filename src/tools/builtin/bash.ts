import { spawn, type ChildProcess } from "node:child_process";

import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { DEFAULT_LIMITS, truncateTail } from "../truncate.ts";

/**
 * 执行 shell 命令。
 *
 * 这是四个核心工具里唯一具备任意执行能力的，所以命令先经沙箱包装再交给 shell——沙箱不需要
 * 替换这个工具本身，它只需要在这里加一层外壳。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		command: { type: "string", description: "要执行的命令，由系统 shell 解析" },
		timeout: {
			type: "integer",
			minimum: 1,
			description: "超时秒数。默认 600；命令超过这个时间会被连同子进程一起终止",
		},
	},
	required: ["command"],
} as const satisfies JsonSchema;

type BashArgs = {
	readonly command: string;
	readonly timeout?: number;
};

/**
 * 默认超时。
 *
 * 不设上限看起来更「不干预」，但一条卡住的命令会把整轮对话永久挂住，而使用者往往以为它还在
 * 干活。十分钟足够真实的构建与测试跑完。
 */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** 累积输出的上限。超出部分拿不回来，但必须告诉模型，否则它会以为这就是全部。 */
const MAX_CAPTURED_BYTES = 5 * 1024 * 1024;

export const bashTool: ToolDefinition<BashArgs> = {
	name: "bash",
	description:
		"在系统 shell 里执行命令，返回合并后的输出与退出码。用于构建、测试、版本控制等操作。" +
		"改文件优先用 edit 或 write，两者能保留原文并给出差异。",
	parameters: PARAMETERS,
	annotations: { readOnly: false, destructive: true, openWorld: true },

	async execute({ args, workspace, sandbox, session, signal }): Promise<ToolResult> {
		const shell = resolveShell();
		const wrapped = sandbox.wrapCommand(args.command);
		const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

		const child = spawn(shell.command, shell.args(wrapped), {
			cwd: workspace.root,
			env: {
				...process.env,
				REINS_SESSION_ID: session.id,
				...(session.path === null ? {} : { REINS_SESSION_FILE: session.path }),
			},
			// 自成进程组，超时或中止时才能把命令带出来的子进程一起结束
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const collected = new OutputCollector(child);
		const stop = { timedOut: false, aborted: false };

		const timer = setTimeout(() => {
			stop.timedOut = true;
			killTree(child);
		}, timeoutMs);
		const onAbort = (): void => {
			stop.aborted = true;
			killTree(child);
		};
		signal.addEventListener("abort", onAbort, { once: true });

		const exited = await waitForExit(child);
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);

		if (!exited.started) {
			return { content: `无法启动 ${shell.command}：${exited.reason}`, isError: true };
		}

		return buildResult({
			output: collected.text(),
			overflowed: collected.overflowed,
			exitCode: exited.code,
			timedOut: stop.timedOut,
			aborted: stop.aborted,
			timeoutMs,
		});
	},
};

interface Shell {
	readonly command: string;
	readonly args: (command: string) => string[];
}

/**
 * 选 shell。
 *
 * 跟随进程自身所在的环境变量而不是写死一个：使用者在一个已经配好工具链的 shell 里启动本
 * 程序，命令理应跑在同一个环境里。
 */
function resolveShell(): Shell {
	if (process.platform === "win32") {
		return {
			command: process.env["COMSPEC"] ?? "cmd.exe",
			args: (command) => ["/d", "/s", "/c", command],
		};
	}
	return {
		command: process.env["SHELL"] ?? "/bin/sh",
		args: (command) => ["-c", command],
	};
}

/**
 * 收集合并后的输出。
 *
 * 标准输出与标准错误合在一起：对使用者的判断来说，命令「报了什么」比「从哪个流报的」更重要，
 * 分两段显示反而要来回对照。超过上限后停止累积，只记下发生过溢出。
 */
class OutputCollector {
	readonly #chunks: Buffer[] = [];
	#kept = 0;
	#overflowed = false;

	constructor(child: ChildProcess) {
		child.stdout?.on("data", (chunk: Buffer) => this.#accept(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.#accept(chunk));
	}

	get overflowed(): boolean {
		return this.#overflowed;
	}

	text(): string {
		return Buffer.concat(this.#chunks).toString("utf8");
	}

	#accept(chunk: Buffer): void {
		if (this.#kept >= MAX_CAPTURED_BYTES) {
			this.#overflowed = true;
			return;
		}
		const remaining = MAX_CAPTURED_BYTES - this.#kept;
		const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
		if (chunk.length > remaining) this.#overflowed = true;
		this.#chunks.push(slice);
		this.#kept += slice.length;
	}
}

interface ExitOutcome {
	readonly started: boolean;
	readonly code: number | null;
	readonly reason: string;
}

function waitForExit(child: ChildProcess): Promise<ExitOutcome> {
	return new Promise((resolve) => {
		child.on("error", (error) => {
			resolve({ started: false, code: null, reason: error.message });
		});
		child.on("close", (code) => {
			resolve({ started: true, code, reason: "" });
		});
	});
}

/** 连同命令带出来的子进程一起结束。只杀直接子进程会留下孤儿进程继续占着端口或文件。 */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function buildResult(input: {
	readonly output: string;
	readonly overflowed: boolean;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly timeoutMs: number;
}): ToolResult {
	const parts: string[] = [];
	if (input.output.length === 0) {
		parts.push("[命令没有输出]");
	} else {
		const truncated = truncateTail(input.output, DEFAULT_LIMITS);
		if (truncated.truncated) {
			parts.push(`[仅显示输出的末尾，共 ${truncated.totalLines} 行]`);
		}
		parts.push(truncated.text);
	}

	if (input.overflowed) {
		parts.push(`[输出超过 ${MAX_CAPTURED_BYTES} 字节，更早的部分已丢弃]`);
	}
	if (input.timedOut) {
		parts.push(`[命令超过 ${input.timeoutMs / 1000} 秒未结束，已连同子进程终止]`);
	}
	if (input.aborted) {
		parts.push("[已中止]");
	}
	if (input.exitCode !== null && input.exitCode !== 0) {
		parts.push(`[命令以退出码 ${input.exitCode} 结束]`);
	}

	const failed = input.timedOut || input.aborted || (input.exitCode !== null && input.exitCode !== 0);
	return {
		content: parts.join("\n"),
		isError: failed,
		details: { exitCode: input.exitCode, timedOut: input.timedOut, aborted: input.aborted },
	};
}
