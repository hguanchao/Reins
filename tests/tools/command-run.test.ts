import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";

import type { SandboxView } from "#src/sandbox/policy.ts";
import type { SessionReadView } from "#src/session/port.ts";
import { prefixScope, runCommand } from "#src/tools/command-run.ts";
import type { Shell, ShellExit, ShellProcess, StartShellProcessInput } from "#src/tools/shell.ts";

/** 假进程：输出与退出状态由用例给定；没有退出状态时一直挂着，用来测超时与中止。 */
function fakeProcess(options: {
	readonly output?: string;
	readonly overflowed?: boolean;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly startFailure?: string;
}): ShellProcess & { readonly killed: () => boolean } {
	let killed = false;
	let settle: (value: ShellExit) => void = () => {};
	const exited = new Promise<ShellExit>((resolve) => {
		settle = resolve;
	});
	if (options.startFailure !== undefined) {
		settle({ started: false, code: null, signal: null, reason: options.startFailure });
	} else if (options.exitCode !== undefined || options.signal !== undefined) {
		settle({ started: true, code: options.exitCode ?? null, signal: options.signal ?? null, reason: "" });
	}
	return {
		child: {} as ChildProcess,
		output: () => ({ text: options.output ?? "", overflowed: options.overflowed ?? false }),
		overflowed: () => options.overflowed ?? false,
		wait: () => exited,
		kill: () => {
			killed = true;
			settle({ started: true, code: null, signal: "SIGKILL", reason: "" });
		},
		killed: () => killed,
	};
}

const SHELL: Shell = { command: "bash", args: (command) => ["-c", command], env: {} };

function sandboxOf(seen: { command?: string } = {}): SandboxView {
	return {
		wrapCommand: (command: string) => {
			seen.command = command;
			return `sandboxed ${command}`;
		},
		assertPathAllowed: () => {},
	} as unknown as SandboxView;
}

const SESSION: SessionReadView = { id: "s-1", path: "C:\\sessions\\s-1.jsonl" };

async function run(options: {
	readonly process: ShellProcess;
	readonly command?: string;
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
	readonly sandbox?: SandboxView;
	readonly seen?: { command?: string };
	readonly seenStart?: { env?: NodeJS.ProcessEnv; cwd?: string };
}) {
	return runCommand({
		shell: SHELL,
		command: options.command ?? "echo hi",
		...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
		workspaceRoot: "C:\\work",
		sandbox: options.sandbox ?? sandboxOf(options.seen),
		session: SESSION,
		signal: options.signal ?? new AbortController().signal,
		start: (input: StartShellProcessInput) => {
			if (options.seenStart !== undefined) {
				options.seenStart.env = input.env;
				options.seenStart.cwd = input.cwd;
			}
			return options.process;
		},
	});
}

describe("前台命令执行", () => {
	it("成功时原样带回输出，退出码 0 不算失败", async () => {
		const result = await run({ process: fakeProcess({ output: "hello", exitCode: 0 }) });

		assert.equal(result.content, "hello");
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, { exitCode: 0, signal: null, timedOut: false, aborted: false });
	});

	it("非零退出码写成标记并算失败", async () => {
		const result = await run({ process: fakeProcess({ output: "boom", exitCode: 3 }) });

		assert.match(result.content, /\[command exited with code 3\]/);
		assert.equal(result.isError, true);
	});

	it("没有输出时给一句明确的占位", async () => {
		const result = await run({ process: fakeProcess({ output: "", exitCode: 0 }) });

		assert.equal(result.content, "[command produced no output]");
	});

	it("被信号杀死时报出信号，而不是当成正常结束", async () => {
		const result = await run({ process: fakeProcess({ output: "partial", exitCode: null, signal: "SIGKILL" }) });

		assert.match(result.content, /\[command was killed by SIGKILL\]/);
		assert.equal(result.isError, true);
	});

	it("累积输出超上限时说明后面的部分被丢掉", async () => {
		const result = await run({ process: fakeProcess({ output: "x", overflowed: true, exitCode: 0 }) });

		assert.match(result.content, /\[output exceeded \d+ bytes; later parts were dropped\]/);
	});

	it("输出过长时只留结尾并报出总行数", async () => {
		const lines = Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`);
		const result = await run({ process: fakeProcess({ output: lines.join("\n"), exitCode: 0 }) });

		assert.match(result.content, /\[showing the end of the output only, 2001 lines in total\]/);
		assert.match(result.content, /line 2001/);
		assert.doesNotMatch(result.content, /line 1\b/);
	});

	it("超时会杀掉进程并说明没跑完", async () => {
		const process = fakeProcess({});
		const result = await run({ process, timeoutSeconds: 0.05 });

		assert.match(result.content, /\[command did not finish within 0.05 seconds; killed with its child processes\]/);
		assert.equal(result.isError, true);
		assert.equal(process.killed(), true);
	});

	it("中止会杀掉进程并标记 aborted", async () => {
		const controller = new AbortController();
		const process = fakeProcess({});
		const pending = run({ process, signal: controller.signal });
		controller.abort();

		const result = await pending;
		assert.match(result.content, /\[aborted\]/);
		assert.equal(result.isError, true);
		assert.equal(process.killed(), true);
	});

	it("起不来的进程报出原因，而不是一段空输出", async () => {
		const result = await run({ process: fakeProcess({ startFailure: "ENOENT" }) });

		assert.equal(result.content, "Failed to start bash: ENOENT");
		assert.equal(result.isError, true);
	});

	it("命令先经沙箱包装，并带上会话标识与工作根", async () => {
		const seen: { command?: string } = {};
		const seenStart: { env?: NodeJS.ProcessEnv; cwd?: string } = {};
		await run({
			process: fakeProcess({ output: "ok", exitCode: 0 }),
			command: "rm -rf build",
			sandbox: sandboxOf(seen),
			seen,
			seenStart,
		});

		assert.equal(seen.command, "rm -rf build");
		assert.equal(seenStart.env?.["REINS_SESSION_ID"], "s-1");
		assert.equal(seenStart.env?.["REINS_SESSION_FILE"], "C:\\sessions\\s-1.jsonl");
		assert.equal(seenStart.cwd, "C:\\work");
	});

	it("内存会话不注入会话文件变量", async () => {
		const seenStart: { env?: NodeJS.ProcessEnv } = {};
		await runCommand({
			shell: SHELL,
			command: "pwd",
			workspaceRoot: "/w",
			sandbox: sandboxOf(),
			session: { id: "mem", path: null },
			signal: new AbortController().signal,
			start: (input) => {
				seenStart.env = input.env;
				return fakeProcess({ output: "/w", exitCode: 0 });
			},
		});

		assert.equal(seenStart.env?.["REINS_SESSION_ID"], "mem");
		assert.equal(seenStart.env?.["REINS_SESSION_FILE"], undefined);
	});
});

describe("前缀放行范围", () => {
	const blocked = new Set(["rm", "sudo"]);

	it("普通命令取前两个词，前缀按原样保存", () => {
		assert.deepEqual(prefixScope(["Cargo", "build", "--release"], blocked), {
			key: "Cargo build",
			label: 'commands starting with "Cargo build"',
			short: "Cargo build",
		});
	});

	it("只有命令名时前缀就是它自己", () => {
		assert.equal(prefixScope(["pwd"], blocked)?.key, "pwd");
	});

	it("排除项与选项开头的第二个词都不给范围", () => {
		assert.equal(prefixScope(["rm", "x"], blocked), undefined);
		assert.equal(prefixScope(["git", "-c", "x"], blocked), undefined);
	});

	it("分词失败时不给范围", () => {
		assert.equal(prefixScope(undefined, blocked), undefined);
		assert.equal(prefixScope([], blocked), undefined);
	});
});
