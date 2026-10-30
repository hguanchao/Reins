import type { SandboxView } from "#src/sandbox/policy.ts";
import type { SessionReadView } from "#src/session/port.ts";
import type { PermissionScope, ToolResult } from "#src/tools/contract.ts";
import {
	MAX_CAPTURED_BYTES,
	startShellProcess,
	type Shell,
	type ShellProcess,
	type StartShellProcessInput,
} from "#src/tools/shell.ts";
import { DEFAULT_LIMITS, truncateTail } from "#src/tools/truncate.ts";

/**
 * 命令类工具的共享部分。
 *
 * bash 与 pwsh 只差两件事：shell 方言，以及怎么把一条命令收成放行范围。起进程、等超时、
 * 中止、收输出、把退出状态写成模型读得懂的结果，两边必须共用同一份实现——否则一边补好的
 * 边界，另一边还照原样漏着。
 */

/**
 * 默认超时。
 *
 * 不设上限看起来更「不干预」，但一条卡住的命令会把整轮对话永久挂住，而使用者往往以为它还在
 * 干活。十分钟足够真实的构建与测试跑完。
 */
export const DEFAULT_TIMEOUT_SECONDS = 600;

export interface RunCommandInput {
	readonly shell: Shell;
	/** 未经沙箱包装的原始命令 */
	readonly command: string;
	readonly timeoutSeconds?: number | undefined;
	readonly workspaceRoot: string;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
	readonly signal: AbortSignal;
	/**
	 * 启动进程的方式；省略时用 shell.ts 的真实实现。
	 *
	 * 超时、中止、溢出与退出状态这些边界靠真实进程测不出来（等十分钟超时不是测试），所以
	 * 把「起进程」留成注入点；被测的是这里的收拢规则，不是 spawn。
	 */
	readonly start?: (input: StartShellProcessInput) => ShellProcess;
}

/** 起一个前台 shell 进程，等到它结束或超时，并把结果写成给模型看的样子。 */
export async function runCommand(input: RunCommandInput): Promise<ToolResult> {
	const timeoutMs = (input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	const shellProcess = (input.start ?? startShellProcess)({
		shell: input.shell,
		command: input.sandbox.wrapCommand(input.command),
		cwd: input.workspaceRoot,
		env: {
			// shell 的默认值先铺，使用者自己的环境优先
			...input.shell.env,
			...process.env,
			REINS_SESSION_ID: input.session.id,
			...(input.session.path === null ? {} : { REINS_SESSION_FILE: input.session.path }),
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
	input.signal.addEventListener("abort", onAbort, { once: true });

	const exited = await shellProcess.wait();
	clearTimeout(timer);
	input.signal.removeEventListener("abort", onAbort);

	if (!exited.started) {
		return { content: `Failed to start ${input.shell.command}: ${exited.reason}`, isError: true };
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
}

/**
 * 由分词结果给出「本会话总是允许」的范围。
 *
 * 两种 shell 共用这一条判断，各自只负责把自己的命令切成词。被挡在外面的情形各有理由：
 * 解释器与包装器的第二个词就是任意代码；第二个词是选项时，选项本身常常能改变要执行什么
 * （`git -c alias.x='!...' x` 就是任意命令），前缀便不再描述实际行为。
 */
export function prefixScope(
	tokens: readonly string[] | undefined,
	blockedHead: ReadonlySet<string>,
): PermissionScope | undefined {
	if (tokens === undefined || tokens.length === 0) return undefined;

	const head = (tokens[0] ?? "").toLowerCase();
	if (blockedHead.has(head)) return undefined;

	const second = tokens[1];
	if (second !== undefined && second.startsWith("-")) return undefined;

	const prefix = tokens.slice(0, 2).join(" ");
	return { key: prefix, label: `commands starting with "${prefix}"`, short: prefix };
}

interface ResultInput {
	readonly output: string;
	readonly overflowed: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly timeoutMs: number;
}

function buildResult(input: ResultInput): ToolResult {
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
