import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SandboxView } from "../../src/sandbox/policy.ts";
import type { SessionReadView } from "../../src/session/port.ts";
import { createTerminalTools, TerminalManager } from "../../src/tools/terminal.ts";
import { WorkspaceBoundary } from "../../src/workspace/boundary.ts";

const WORKSPACE = new WorkspaceBoundary(process.cwd());
const SANDBOX: SandboxView = {
	assertPathAllowed: () => undefined,
	wrapCommand: (command) => command,
};
const SESSION: SessionReadView = { id: "test-session", path: null };

/** POSIX 逐行读 stdin 并回显；Git Bash 与 /bin/sh 都支持。 */
const ECHO_LOOP = "while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done";

/** 输出可能先于 close 事件到达；轮询到进程真正结束，再取整段保留输出。 */
async function waitForExit(manager: TerminalManager, id: string) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const read = await manager.read(id, 1000, false);
		if (read === undefined) return undefined;
		if (read.view.status !== "running") return manager.read(id, 0, true);
	}
	return manager.read(id, 0, true);
}

describe("持久终端", () => {
	it("启动后保持 stdin，写入与增量读取", async () => {
		const manager = new TerminalManager();
		try {
			const view = manager.start({
				command: ECHO_LOOP,
				workspace: WORKSPACE,
				sandbox: SANDBOX,
				session: SESSION,
			});
			assert.equal(view.status, "running");

			const first = await manager.write(view.id, "hello", true, 2000);
			assert.ok(first !== undefined);
			assert.match(first.output, /got:hello/);

			const second = await manager.write(view.id, "world", true, 2000);
			assert.ok(second !== undefined);
			assert.match(second.output, /got:world/);

			// 上一次写入已经读走全部输出，这里没有新内容
			const idle = await manager.read(view.id, 0, false);
			assert.ok(idle !== undefined);
			assert.equal(idle.output, "");

			// all 返回整段保留缓冲
			const all = await manager.read(view.id, 0, true);
			assert.ok(all !== undefined);
			assert.match(all.output, /got:hello/);
			assert.match(all.output, /got:world/);

			await manager.kill(view.id);
			const after = await manager.read(view.id, 2000, false);
			assert.ok(after !== undefined);
			assert.notEqual(after.view.status, "running");
		} finally {
			manager.shutdown();
		}
	});

	it("进程自行退出时记录退出码与最终输出", async () => {
		const manager = new TerminalManager();
		try {
			const view = manager.start({
				command: "printf 'done\\n'",
				workspace: WORKSPACE,
				sandbox: SANDBOX,
				session: SESSION,
			});
			const read = await waitForExit(manager, view.id);
			assert.ok(read !== undefined);
			assert.equal(read.view.status, "exited");
			assert.equal(read.view.exitCode, 0);
			assert.match(read.output, /done/);
		} finally {
			manager.shutdown();
		}
	});

	it("输出里的终端控制序列被清掉", async () => {
		const manager = new TerminalManager();
		try {
			const view = manager.start({
				command: "printf '\\033[31mred\\033[0m\\n'",
				workspace: WORKSPACE,
				sandbox: SANDBOX,
				session: SESSION,
			});
			const read = await manager.read(view.id, 2000, false);
			assert.ok(read !== undefined);
			assert.equal(read.output.includes("\u001b"), false);
			assert.match(read.output, /red/);
		} finally {
			manager.shutdown();
		}
	});

	it("未知 id 的读写与终止都返回 undefined", async () => {
		const manager = new TerminalManager();
		assert.equal(await manager.write("t99", "x", true, 0), undefined);
		assert.equal(await manager.read("t99", 0, false), undefined);
		assert.equal(await manager.kill("t99"), undefined);
		manager.shutdown();
	});

	it("工具层：启动、写入、读取、终止", async () => {
		const manager = new TerminalManager();
		try {
			const tools = createTerminalTools(manager);
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["terminal_start", "terminal_write", "terminal_kill"],
			);
			const byName = new Map(tools.map((tool) => [tool.name, tool]));

			const started = await byName.get("terminal_start")!.execute({
				args: { command: ECHO_LOOP, waitMs: 1000 },
				workspace: WORKSPACE,
				sandbox: SANDBOX,
				session: SESSION,
			} as never);
			assert.match(started.content, /Started terminal t1/);
			const id = (started.details as { readonly terminalId?: string }).terminalId;
			assert.equal(id, "t1");

			const written = await byName.get("terminal_write")!.execute({
				args: { id, input: "tool", waitMs: 2000 },
			} as never);
			assert.match(written.content, /got:tool/);

			// 省略 input 就是只读：上一笔写入已经把输出读走，这里没有新内容
			const readOnly = await byName.get("terminal_write")!.execute({
				args: { id, waitMs: 0 },
			} as never);
			assert.match(readOnly.content, /Terminal t1 · running/);
			assert.match(readOnly.content, /\[no new output\]/);

			const killed = await byName.get("terminal_kill")!.execute({ args: { id } } as never);
			assert.match(killed.content, /Stopping terminal t1|already/);
		} finally {
			manager.shutdown();
		}
	});

	it("启动工具的放行范围沿用命令前缀，写入按终端 id 记忆", () => {
		const manager = new TerminalManager();
		const tools = createTerminalTools(manager);
		const byName = new Map(tools.map((tool) => [tool.name, tool]));

		// 解释器命令不给「本会话总是允许」
		assert.equal(
			byName.get("terminal_start")!.permissionScope?.({ command: "python -i" }, WORKSPACE),
			undefined,
		);
		const scope = byName.get("terminal_write")!.permissionScope?.({ id: "t3" }, WORKSPACE);
		assert.equal(scope?.key, "t3");
		manager.shutdown();
	});
});
