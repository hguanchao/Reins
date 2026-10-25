import { describeError } from "../../describe-error.ts";
import type { JobManager } from "../jobs.ts";
import type { PermissionScope, ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { MAX_CAPTURED_BYTES, resolveShell, startShellProcess } from "../shell-process.ts";
import { DEFAULT_LIMITS, truncateTail } from "../truncate.ts";

export { resolveShell } from "../shell-process.ts";

/**
 * 执行 shell 命令。
 *
 * 这是四个核心工具里唯一具备任意执行能力的，所以命令先经沙箱包装再交给 shell——沙箱不需要
 * 替换这个工具本身，它只需要在这里加一层外壳。
 *
 * background 为 true 时不在本轮等待：进程交给宿主的 JobManager，工具立刻返回 job id；
 * 前台命令仍保持原来的超时、中止与输出截断。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		command: { type: "string", description: "Shell command to run. It starts in the workspace root." },
		timeout: {
			type: "integer",
			minimum: 1,
			description:
				"Timeout in seconds. Foreground commands default to 600; background commands run without a timeout when omitted.",
		},
		background: {
			type: "boolean",
			description:
				"Run the command as a background job and return its job id immediately. Use job_output to read " +
				"its output or kill_job to stop it.",
		},
	},
	required: ["command"],
} as const satisfies JsonSchema;

type BashArgs = {
	readonly command: string;
	readonly timeout?: number;
	readonly background?: boolean;
};

/**
 * 默认超时。
 *
 * 不设上限看起来更「不干预」，但一条卡住的命令会把整轮对话永久挂住，而使用者往往以为它还在
 * 干活。十分钟足够真实的构建与测试跑完。
 */
const DEFAULT_TIMEOUT_SECONDS = 600;

export function createBashTool(shellPath?: string, jobs?: JobManager): ToolDefinition<BashArgs> {
	return {
		name: "bash",
		summary: "Run a shell command in the workspace root (Git Bash on Windows)",
		description:
			"Run a shell command in the workspace root and return its combined output and exit status. Use paths " +
			"relative to the root and do not prefix commands with cd. Prefer one simple command per call, and use the " +
			`dedicated file and search tools when they fit. Output is truncated from the end beyond ` +
			`${DEFAULT_LIMITS.maxLines} lines or ${DEFAULT_LIMITS.maxBytes / 1024} KB; a non-zero exit code marks the ` +
			"call as failed. Set background to true for long-running commands; otherwise the call waits for the " +
			"command to finish. " +
			(process.platform === "win32"
				? "On Windows the shell is Git Bash: use POSIX syntax and /c/... paths, not cmd.exe syntax. "
				: "") +
			"Use it for builds, tests, version control and similar tasks. Prefer edit or write for file changes: they " +
			"keep the original text and report a diff.",
		parameters: PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: true },

		/** 只记住简单命令的前缀；含管道、重定向、链式命令时不给“总是允许” */
		permissionScope(args): PermissionScope | undefined {
			return commandScope(args.command);
		},

		async execute({ args, workspace, sandbox, session, signal }): Promise<ToolResult> {
			if (args.background === true) {
				if (jobs === undefined) {
					return {
						content: "Background jobs are unavailable in this mode; run the command without background.",
						isError: true,
					};
				}
				try {
					const job = jobs.start({
						command: args.command,
						workspace,
						sandbox,
						session,
						...(args.timeout === undefined ? {} : { timeoutSeconds: args.timeout }),
					});
					return {
						content:
							`Started background job ${job.id}: ${args.command}\n` +
							`Use job_output with id "${job.id}" to read output, or kill_job to stop it.`,
						details: { jobId: job.id, background: true },
					};
				} catch (error) {
					return {
						content: `Failed to start background job: ${describeError(error)}`,
						isError: true,
					};
				}
			}

			const shell = resolveShell(undefined, shellPath);
			const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
			const shellProcess = startShellProcess({
				shell,
				command: sandbox.wrapCommand(args.command),
				cwd: workspace.root,
				env: {
					// shell 的默认值先铺，使用者自己的环境优先
					...shell.env,
					...process.env,
					REINS_SESSION_ID: session.id,
					...(session.path === null ? {} : { REINS_SESSION_FILE: session.path }),
				},
			});
			const stop = { timedOut: false, aborted: false };

			const timer = setTimeout(() => {
				stop.timedOut = true;
				shellProcess.kill();
			}, timeoutMs);
			const onAbort = (): void => {
				stop.aborted = true;
				shellProcess.kill();
			};
			signal.addEventListener("abort", onAbort, { once: true });

			const exited = await shellProcess.wait();
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);

			if (!exited.started) {
				return { content: `Failed to start ${shell.command}: ${exited.reason}`, isError: true };
			}

			const output = shellProcess.output();
			return buildResult({
				output: output.text,
				overflowed: output.overflowed,
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
