import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { killProcessTree, resolvePowerShell, resolveShell, startShellProcess } from "#src/tools/shell.ts";

describe("进程树终止", () => {
	it("spawn 之后立刻请求终止也能杀掉进程", async () => {
		const shell = resolveShell();
		const child = spawn(shell.command, shell.args("sleep 30"), {
			stdio: "ignore",
			windowsHide: true,
		});

		// spawn 返回时 pid 往往还没分配：不等待就放弃的话，这个进程会跑满 30 秒，
		// 而调用方以为它已经被杀掉了
		const startedAt = Date.now();
		killProcessTree(child);

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("进程没有被终止")), 15_000);
			child.on("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});

		assert.ok(Date.now() - startedAt < 10_000, "进程应当被立刻终止，而不是等它自己结束");
	});

	it("命令退出但管道被孙进程占住时，等待也能及时结束", async () => {
		const shell = resolveShell();
		const running = startShellProcess({
			shell,
			// 后台子进程继承了 stdout/stderr：close 要等它跑完才触发，而命令本身已经退出
			command: "sleep 5 & exit 0",
			cwd: process.cwd(),
			env: { ...process.env },
		});

		const startedAt = Date.now();
		const exit = await running.wait();
		assert.equal(exit.started, true);
		assert.ok(Date.now() - startedAt < 3_000, "不应等后台进程跑完才判定结束");
		running.kill();
	});
});

describe("PowerShell 选择", () => {
	function lookup(overrides: {
		readonly platform?: NodeJS.Platform;
		readonly env?: NodeJS.ProcessEnv;
		readonly exists?: (path: string) => boolean;
		readonly which?: (name: string) => readonly string[];
	}) {
		return {
			platform: overrides.platform ?? ("win32" as NodeJS.Platform),
			env: overrides.env ?? {},
			exists: overrides.exists ?? (() => false),
			which: overrides.which ?? (() => []),
		};
	}

	it("Windows 优先 PATH 上的 PowerShell 7", () => {
		const expected = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const shell = resolvePowerShell(
			lookup({
				which: (name) => (name === "pwsh.exe" ? [expected] : []),
				exists: (path) => path === expected,
			}),
		);

		assert.equal(shell.command, expected);
	});

	it("PATH 上没有时找 PowerShell 7 的默认安装位置", () => {
		const expected = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const shell = resolvePowerShell(
			lookup({
				env: { ProgramFiles: "C:\\Program Files" },
				exists: (path) => path === expected,
			}),
		);

		assert.equal(shell.command, expected);
	});

	it("都没有时退回系统自带的 Windows PowerShell", () => {
		const expected = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		const shell = resolvePowerShell(
			lookup({
				env: { SystemRoot: "C:\\Windows" },
				exists: (path) => path === expected,
			}),
		);

		assert.equal(shell.command, expected);
	});

	it("连系统自带的也没有时明确报错", () => {
		assert.throws(() => resolvePowerShell(lookup({ env: { SystemRoot: "D:\\Windows" } })), /No PowerShell found/);
	});

	it("参数固定跳过 profile、非交互执行，并先切到 UTF-8 输出", () => {
		const shell = resolvePowerShell(
			lookup({
				env: { SystemRoot: "C:\\Windows" },
				exists: (path) => path.endsWith("powershell.exe"),
			}),
		);
		const args = shell.args("Get-Date");

		assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
		assert.match(args[3] ?? "", /\[Console\]::OutputEncoding=\[Text\.UTF8Encoding\]::new\(\)/);
		assert.match(args[3] ?? "", /Get-Date$/);
	});

	it("非 Windows 只在 PATH 上找 PowerShell 7", () => {
		assert.throws(() => resolvePowerShell(lookup({ platform: "linux" })), /No PowerShell found on PATH/);

		const shell = resolvePowerShell(
			lookup({
				platform: "linux",
				which: (name) => (name === "pwsh" ? ["/usr/bin/pwsh"] : []),
				exists: (path) => path === "/usr/bin/pwsh",
			}),
		);
		assert.equal(shell.command, "/usr/bin/pwsh");
	});
});
