import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { join } from "node:path";

import stripAnsi from "strip-ansi";

import type { PermissionScope, ToolDefinition, ToolResult } from "../contract.ts";
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
		command: { type: "string", description: "The command to run, parsed by the system shell." },
		timeout: {
			type: "integer",
			minimum: 1,
			description: "Timeout in seconds. Defaults to 600; a longer run is killed together with its child processes.",
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

export function createBashTool(shellPath?: string): ToolDefinition<BashArgs> {
	return {
		name: "bash",
		description:
			"Run a command in the system shell and return the combined output plus the exit code. " +
			(process.platform === "win32"
				? "On Windows the shell is Git Bash: use POSIX syntax and /c/... paths, not cmd.exe syntax. "
				: "") +
			"Use it for builds, tests, version control and similar tasks. Prefer edit or write for file changes: they keep " +
			"the original text and report a diff.",
		parameters: PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: true },

		/** 只记住简单命令的前缀；含管道、重定向、链式命令时不给“总是允许” */
		permissionScope(args): PermissionScope | undefined {
			return commandScope(args.command);
		},

		async execute({ args, workspace, sandbox, session, signal }): Promise<ToolResult> {
			const shell = resolveShell(undefined, shellPath);
			const wrapped = sandbox.wrapCommand(args.command);
			const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

			const child = spawn(shell.command, shell.args(wrapped), {
				cwd: workspace.root,
				env: {
					// shell 的默认值先铺，使用者自己的环境优先
					...shell.env,
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
				return { content: `Failed to start ${shell.command}: ${exited.reason}`, isError: true };
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
}

/**
 * bash 的会话放行范围：命令前缀（最多两个词）。
 *
 * 含 shell 操作符的命令不提供“总是允许”：一个前缀保存之后，链式命令会跟着被放行。前缀
 * 取前两个词，让 `git status`、`npm test` 这类常见组合能覆盖同族参数，又不至于宽到整个
 * 解释器。
 */
export function commandScope(command: string): PermissionScope | undefined {
	const tokens = tokenizeCommand(command);
	if (tokens === undefined || tokens.length === 0) return undefined;

	const prefix = tokens.slice(0, 2).join(" ");
	return { key: prefix, label: `commands starting with "${prefix}"`, short: prefix };
}

/**
 * 保守的命令分词。
 *
 * 只接受没有操作符的简单命令；引号与反斜杠按 shell 的习惯处理。转义不完整或引号没闭合
 * 时返回 undefined，宁可只允许一次，也不猜一个可能更宽的前缀。
 */
function tokenizeCommand(command: string): readonly string[] | undefined {
	if (/[;&|<>`$\n\r]/.test(command) || command.includes("$(")) return undefined;

	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaped || quote !== undefined) return undefined;
	if (current.length > 0) tokens.push(current);
	return tokens;
}

interface Shell {
	readonly command: string;
	readonly args: (command: string) => string[];
	/** 额外注入的环境变量；使用者自己的环境优先 */
	readonly env: Readonly<Record<string, string>>;
}

/** resolveShell 的输入来源；抽出来是为了在非 Windows 上也能测试 Windows 的分支。 */
interface ShellLookup {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly exists: (path: string) => boolean;
	/** 返回 PATH 上所有同名可执行文件，按查找顺序排列 */
	readonly which: (name: string) => readonly string[];
}

/**
 * 选 shell。
 *
 * Windows 上工具叫 bash，就必须真的跑 bash：cmd.exe 不理解 `pwd`、`/c/...` 这类写法，
 * 也不保证 UTF-8 输出。优先常见的 Git Bash 安装位置，再查 PATH；WSL 的 bash 采用另一套
 * 路径规则，不能和这里给模型的 POSIX 提示混用，因此跳过。找不到就明确报错，不静默退回 cmd。
 */
export function resolveShell(lookup: ShellLookup = systemLookup(), shellPath?: string): Shell {
	if (shellPath !== undefined) {
		if (!lookup.exists(shellPath)) {
			throw new Error(
				`Configured shellPath not found: ${shellPath}; set shellPath or shell_path in config.toml`,
			);
		}
		return bashShell(shellPath);
	}

	if (lookup.platform !== "win32") {
		return {
			command: lookup.env["SHELL"] ?? "/bin/sh",
			args: (command) => ["-c", command],
			env: {},
		};
	}

	for (const candidate of gitBashCandidates(lookup.env)) {
		if (lookup.exists(candidate)) return bashShell(candidate);
	}

	for (const candidate of lookup.which("bash.exe")) {
		if (!isWslBash(candidate)) return bashShell(candidate);
	}

	throw new Error(
		"No bash found. On Windows Reins runs commands with Git Bash; install Git for Windows, make sure " +
			"bash.exe is on PATH, or set shellPath or shell_path in config.toml. WSL bash is not used.",
	);
}

function bashShell(command: string): Shell {
	return {
		command,
		args: (input) => ["-c", input],
		// 系统代码页输出（中文 Windows 上是 GBK）到 UTF-8 解码会变成乱码；先给解释器一个
		// UTF-8 默认值，使用者自己设置的同名变量仍然优先
		env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8:surrogateescape" },
	};
}

function gitBashCandidates(env: NodeJS.ProcessEnv): readonly string[] {
	const roots = [
		env["ProgramFiles"],
		env["ProgramFiles(x86)"],
		env["LOCALAPPDATA"] === undefined ? undefined : join(env["LOCALAPPDATA"], "Programs"),
	];
	return roots
		.filter((root): root is string => root !== undefined && root.length > 0)
		.map((root) => join(root, "Git", "bin", "bash.exe"));
}

function isWslBash(path: string): boolean {
	const normalized = path.toLowerCase().replaceAll("/", "\\");
	return (
		/\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized) ||
		/\\windowsapps\\bash\.exe$/.test(normalized)
	);
}

function systemLookup(): ShellLookup {
	return {
		platform: process.platform,
		env: process.env,
		exists: (path) => {
			try {
				accessSync(path);
				return true;
			} catch {
				return false;
			}
		},
		which: findOnPath,
	};
}

function findOnPath(name: string): readonly string[] {
	const finder = process.platform === "win32" ? "where.exe" : "which";
	try {
		const result = spawnSync(finder, [name], { encoding: "utf8", timeout: 5000, windowsHide: true });
		if (result.status !== 0 || typeof result.stdout !== "string") return [];
		return result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
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
		return sanitizeOutput(Buffer.concat(this.#chunks).toString("utf8"));
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

/**
 * 清掉终端转义序列与控制字符。
 *
 * 命令输出会进入模型上下文：颜色码与光标控制对模型没有意义，二进制控制字符还可能破坏
 * 界面与统计。制表、换行、回车保留，它们是正文的一部分。
 */
function sanitizeOutput(text: string): string {
	return stripAnsi(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
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
		// 用 System32 下的绝对路径，避免 PATH 上有同名程序时杀错东西
		const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
		try {
			const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			// spawn 失败只会发 error 事件；不消费就会变成未捕获异常
			killer.on("error", () => child.kill());
		} catch {
			child.kill();
		}
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
		parts.push("[command produced no output]");
	} else {
		const truncated = truncateTail(input.output, DEFAULT_LIMITS);
		if (truncated.truncated) {
			parts.push(`[showing the end of the output only, ${truncated.totalLines} lines in total]`);
		}
		parts.push(truncated.text);
	}

	if (input.overflowed) {
		parts.push(`[output exceeded ${MAX_CAPTURED_BYTES} bytes; earlier parts were dropped]`);
	}
	if (input.timedOut) {
		parts.push(`[command did not finish within ${input.timeoutMs / 1000} seconds; killed with its child processes]`);
	}
	if (input.aborted) {
		parts.push("[aborted]");
	}
	if (input.exitCode !== null && input.exitCode !== 0) {
		parts.push(`[command exited with code ${input.exitCode}]`);
	}

	const failed = input.timedOut || input.aborted || (input.exitCode !== null && input.exitCode !== 0);
	return {
		content: parts.join("\n"),
		isError: failed,
		details: { exitCode: input.exitCode, timedOut: input.timedOut, aborted: input.aborted },
	};
}
