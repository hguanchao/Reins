import type { PermissionScope, ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { prefixScope, runCommand } from "../command-run.ts";
import { resolveShell } from "../shell.ts";
import { DEFAULT_LIMITS } from "../truncate.ts";

export { resolveShell } from "../shell.ts";

/**
 * 执行 shell 命令。
 *
 * 这是核心工具里唯一具备任意执行能力的，所以命令先经沙箱包装再交给 shell——沙箱不需要
 * 替换这个工具本身，它只需要在这里加一层外壳。
 *
 * 一次调用就是一个前台进程：超时、中止与输出截断都在本轮内完成，不回传任何句柄。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		command: { type: "string", description: "Shell command to run. It starts in the workspace root." },
		timeout: { type: "integer", minimum: 1, description: "Timeout in seconds. Defaults to 600." },
	},
	required: ["command"],
} as const satisfies JsonSchema;

type BashArgs = {
	readonly command: string;
	readonly timeout?: number;
};

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
				? "On Windows this shell is Git Bash: use POSIX syntax and /c/... paths, not cmd.exe syntax; " +
					"the pwsh tool speaks the native Windows dialect. "
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
			return runCommand({
				shell: resolveShell(undefined, shellPath),
				command: args.command,
				...(args.timeout === undefined ? {} : { timeoutSeconds: args.timeout }),
				workspaceRoot: workspace.root,
				sandbox,
				session,
				signal,
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
 */
export function commandScope(command: string): PermissionScope | undefined {
	return prefixScope(tokenizeCommand(command), INTERPRETER_COMMANDS);
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
