import type { PermissionScope, ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { MAX_CAPTURED_BYTES, resolveShell, startShellProcess } from "../shell.ts";
import { DEFAULT_LIMITS, truncateTail } from "../truncate.ts";

export { resolveShell } from "../shell.ts";

/**
 * 执行 shell 命令。
 *
 * 这是四个核心工具里唯一具备任意执行能力的，所以命令先经沙箱包装再交给 shell——沙箱不需要
 * 替换这个工具本身，它只需要在这里加一层外壳。
 *
 * 一次调用就是一个前台进程：超时、中止与输出截断都在本轮内完成，不回传任何句柄。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		command: { type: "string", description: "Shell command to run. It starts in the workspace root." },
		timeout: {
			type: "integer",
			minimum: 1,
			description: "Timeout in seconds. Defaults to 600.",
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

export function createBashTool(shellPath?: string): ToolDefinition<BashArgs> {
	return {
		name: "bash",
		summary: "Run a shell command in the workspace root (Git Bash on Windows)",
		description:
			"Run a shell command in the workspace root and return its combined output and exit status. Use paths " +
			"relative to the root and do not prefix commands with cd. Prefer one simple command per call, and use the " +
			`dedicated file and search tools when they fit. Output is truncated from the end beyond ` +
			`${DEFAULT_LIMITS.maxLines} lines or ${DEFAULT_LIMITS.maxBytes / 1024} KB; a non-zero exit code marks the ` +
			"call as failed. The call waits for the command to finish. " +
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
				signal: exited.signal,
				timedOut: stop.timedOut,
				aborted: stop.aborted,
				timeoutMs,
			});
		},
	};
}

/**
 * 解释器与命令包装器：这些命令的第二个词本身就能指定「执行任意东西」，按前缀放行等于
 * 放行一切。
 *
 * `bash -c '...'`、`python -c '...'`、`node -e '...'` 的载荷完全在引号里，前缀永远相同；
 * `xargs rm`、`find . -delete` 同理——真正危险的部分落在前缀之外。这类命令一律不给
 * 「总是允许」，只能逐次确认。
 */
const INTERPRETER_COMMANDS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"cmd",
	"powershell",
	"pwsh",
	"python",
	"python3",
	"node",
	"deno",
	"bun",
	"perl",
	"ruby",
	"php",
	"lua",
	"osascript",
	"eval",
	"exec",
	"source",
	"xargs",
	"find",
	"env",
	"nice",
	"time",
	"sudo",
	"doas",
	"su",
	"nohup",
	"timeout",
	"watch",
	"ssh",
	"scp",
	"rsync",
	"docker",
	"podman",
	"kubectl",
	"helm",
	"npx",
	"pnpx",
	"bunx",
]);

/**
 * bash 的会话放行范围：命令前缀（最多两个词）。
 *
 * 含 shell 操作符的命令不提供“总是允许”：一个前缀保存之后，链式命令会跟着被放行。
 *
 * 只有「普通命令 + 非选项参数」才提供前缀。两条排除各有理由：
 * 解释器与包装器的第二个词就是任意代码（见 INTERPRETER_COMMANDS）；第二个词是选项时，
 * 选项本身常常能改变要执行什么（`git -c alias.x='!...' x` 就是任意命令），前缀便不再
 * 描述实际行为。
 */
export function commandScope(command: string): PermissionScope | undefined {
	const tokens = tokenizeCommand(command);
	if (tokens === undefined || tokens.length === 0) return undefined;

	const head = (tokens[0] ?? "").toLowerCase();
	if (INTERPRETER_COMMANDS.has(head)) return undefined;

	const second = tokens[1];
	if (second !== undefined && second.startsWith("-")) return undefined;

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
	readonly signal: string | null;
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
		// 累积到上限后就不再收：丢掉的是后面的输出，不是前面的
		parts.push(`[output exceeded ${MAX_CAPTURED_BYTES} bytes; later parts were dropped]`);
	}
	if (input.timedOut) {
		parts.push(`[command did not finish within ${input.timeoutMs / 1000} seconds; killed with its child processes]`);
	}
	if (input.aborted) {
		parts.push("[aborted]");
	}
	// 被信号杀死时 code 为 null：不单独报出来，这次失败会看起来像成功
	if (input.signal !== null) {
		parts.push(`[command was killed by ${input.signal}]`);
	} else if (input.exitCode !== null && input.exitCode !== 0) {
		parts.push(`[command exited with code ${input.exitCode}]`);
	}

	const failed =
		input.timedOut ||
		input.aborted ||
		input.signal !== null ||
		(input.exitCode !== null && input.exitCode !== 0);
	return {
		content: parts.join("\n"),
		isError: failed,
		details: {
			exitCode: input.exitCode,
			signal: input.signal,
			timedOut: input.timedOut,
			aborted: input.aborted,
		},
	};
}
