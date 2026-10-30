import { prefixScope, runCommand } from "../command-run.ts";
import type { PermissionScope, ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";
import { resolvePowerShell } from "../shell.ts";
import { DEFAULT_LIMITS } from "../truncate.ts";

export { resolvePowerShell } from "../shell.ts";

/**
 * 执行 PowerShell 命令。
 *
 * 它补的是 bash 工具在 Windows 上够不到的那一半：Git Bash 只认 POSIX 写法，而 cmdlet、
 * `C:\...` 路径、`$env:NAME`、服务与注册表这些原生入口只有 PowerShell 说得出。两个工具各自
 * 声明自己的方言，模型就不必在一种 shell 里写另一种 shell 的语法。
 *
 * 执行方式与 bash 完全一致——一次调用一个新进程，超时、中止、截断都走同一份实现。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		command: { type: "string", description: "PowerShell command to run. It starts in the workspace root." },
		timeout: { type: "integer", minimum: 1, description: "Timeout in seconds. Defaults to 600." },
	},
	required: ["command"],
} as const satisfies JsonSchema;

type PwshArgs = {
	readonly command: string;
	readonly timeout?: number;
};

export function createPwshTool(): ToolDefinition<PwshArgs> {
	return {
		name: "pwsh",
		summary: "Run a PowerShell command in the workspace root (native Windows syntax)",
		description:
			"Run one PowerShell command in the workspace root and return its combined output and exit status. Each " +
			"call starts a fresh non-interactive process, so state does not carry between calls. Use native Windows " +
			"paths (`C:\\...`) and read environment variables as `$env:NAME`; use paths relative to the root and do " +
			"not prefix commands with cd. Prefer one simple command per call, and use the dedicated file and search " +
			"tools when they fit. Output is truncated from the end beyond " +
			`${DEFAULT_LIMITS.maxLines} lines or ${DEFAULT_LIMITS.maxBytes / 1024} KB; a non-zero exit code marks the ` +
			"call as failed. A killed process can settle as exit code 1 with no signal marker on Windows: read an " +
			"unexpected bare 1 after a timeout or abort as an interruption, not a command failure. Variable names are " +
			"case-insensitive and automatic variables are read-only, so do not assign to `$HOME` or `$PID`. Before a " +
			"delete or move, check that the resolved absolute target is the intended path. Use it for builds, tests, " +
			"version control and Windows-specific administration. Prefer edit or write for file changes: they keep the " +
			"original text and report a diff.",
		parameters: PARAMETERS,
		annotations: { readOnly: false, destructive: true, openWorld: true },

		/** 只记住简单命令的前缀；链式、管道与表达式一律逐次确认 */
		permissionScope(args): PermissionScope | undefined {
			return commandScope(args.command);
		},

		async execute({ args, workspace, sandbox, session, signal }): Promise<ToolResult> {
			return runCommand({
				shell: resolvePowerShell(),
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
 * 能执行任意代码的开头。
 *
 * `iex`、`Invoke-Expression`、`Add-Type`、`New-Object` 的第二个词就是脚本或类型名；调用运算符
 * `&` 与点源 `.` 直接把后面的一切都变成命令；循环与分支的关键字里可以包住任何命令。按这类
 * 前缀放行等于放行一切，所以它们只能逐次确认。外部解释器（cmd、cscript、另一个 powershell）
 * 同理——真正的载荷落在前缀之外。
 */
const ANY_CODE_HEADS: ReadonlySet<string> = new Set([
	"pwsh",
	"powershell",
	"powershell_ise",
	"cmd",
	"cscript",
	"wscript",
	"mshta",
	"rundll32",
	"regsvr32",
	"bash",
	"sh",
	"iex",
	"invoke-expression",
	"icm",
	"invoke-command",
	"start-process",
	"spps",
	"start-job",
	"start-threadjob",
	"invoke-item",
	"ii",
	"add-type",
	"new-object",
	"&",
	".",
	"foreach",
	"for",
	"if",
	"while",
	"do",
	"switch",
	"param",
	"begin",
	"process",
	"end",
]);

/**
 * 出现即不给「总是允许」的 PowerShell 元字符。
 *
 * 分号与竖线把一条命令变成一串，`&` 是调用运算符与后台作业标记，`$`、`(`、`{`、反引号说明
 * 参数来自表达式或换行，重定向改写文件——这些都不是一个只读前缀能描述清楚的行为。
 */
const SHELL_METACHARACTERS = /[$;&|<>`(){}\n\r]/;

/**
 * pwsh 的会话放行范围：命令前缀（最多两个词）。
 *
 * 与 bash 共用「前缀 + 排除项」这条判断，只有分词规则按 PowerShell 的写法另写：反引号转义
 * 与变量插值已经被元字符检查挡在外面，这里只需处理引号与空白。
 */
export function commandScope(command: string): PermissionScope | undefined {
	return prefixScope(tokenizeCommand(command), ANY_CODE_HEADS);
}

/**
 * 保守的命令分词。
 *
 * 含元字符的命令直接不收；引号内的内容当作一个字面的词，未闭合的引号返回 undefined——宁可
 * 只允许这一次，也不猜一个可能更宽的前缀。
 */
function tokenizeCommand(command: string): readonly string[] | undefined {
	if (SHELL_METACHARACTERS.test(command)) return undefined;

	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;

	for (const char of command) {
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

	if (quote !== undefined) return undefined;
	if (current.length > 0) tokens.push(current);
	return tokens;
}
