import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { killProcessTree, resolveShell, startShellProcess } from "../../src/tools/shell.ts";

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
