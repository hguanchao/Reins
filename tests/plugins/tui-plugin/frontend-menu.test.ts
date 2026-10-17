import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import { cleanupTempDirs, lastFrameRows, MemoryTerminal, runtimeOf, waitForRows, workspaceFixture } from "./frontend-harness.ts";

/**
 * 前端集成测试——命令与文件下拉。
 *
 * 斜杠与 @ 补全都走真实的按键流：输入触发下拉、方向键与滚轮移动选择、Tab/Enter/鼠标接受、
 * Esc 只收起不清稿。
 */

afterEach(() => {
	cleanupTempDirs();
});

describe("前端：命令与文件下拉", () => {
	it("输入斜杠显示命令下拉，方向键选择后 Tab 补全", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		for (const name of ["/help", "/exit", "/notify", "/trust"]) {
			assert.ok(rows.some((line) => line.includes(name)), `dropdown lists ${name}`);
		}
		assert.ok(rows.some((line) => line.includes("Show this help")), "description column");

		// 选中项默认是第一项 help；下移到 exit
		terminal.inputListener?.("\x1b[B");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /exit")), "Tab accepts the selected command");
		assert.ok(!rows.some((line) => line.includes("Show this help")), "dropdown closes after completion");

		terminal.inputListener?.("\x03"); // 清空
		terminal.quit();
		await running;
	});

	it("斜杠查询过滤候选；未完整输入时 Enter 只补全", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/he");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("/help")));
		assert.ok(!rows.some((line) => line.includes("/exit")), "non-matching commands are filtered out");

		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /help")), "partial command is completed, not executed");
		assert.ok(!rows.some((line) => line.includes("Interface commands")), "command did not run yet");

		// 已经完整打出命令：再按 Enter 执行
		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(
			rows.some((line) => line.includes("While browsing, Home/End")),
			"exact command executes",
		);

		terminal.quit();
		await running;
	});

	it("Esc 只收起斜杠下拉，不清空输入；鼠标单击选中、双击接受", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/he");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));
		let rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /he")), "Esc keeps the draft");
		assert.ok(!rows.some((line) => line.includes("Show this help")), "Esc closes the dropdown");

		// 回到空输入，重新打开下拉后用鼠标选 exit
		terminal.inputListener?.("\x03");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("/");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		const exitRow = rows.findIndex((line) => line.includes("/exit"));
		assert.ok(exitRow >= 0, "exit row is visible");
		const exitCol = rows[exitRow].indexOf("/exit") + 1;
		for (let click = 0; click < 2; click += 1) {
			terminal.inputListener?.(`\x1b[<0;${exitCol};${exitRow + 1}M`);
			terminal.inputListener?.(`\x1b[<0;${exitCol};${exitRow + 1}m`);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ /exit")), "double-click accepts the row");
		assert.ok(!rows.some((line) => line.includes("Show this help")), "dropdown closes after mouse accept");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("@ 文件补全：过滤、Tab 插入与目录钻取", async () => {
		const root = workspaceFixture();
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = { ...runtimeOf(), cwd: root };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("open @app");
		let rows = await waitForRows(terminal, (frame) => frame.some((line) => line.includes("src/app.ts")));
		assert.ok(rows.some((line) => line.includes("src/app.ts")), "file matches appear");
		assert.ok(!rows.some((line) => line.includes("src/util.ts")), "query filters other files");

		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("open @src/app.ts ")), "Tab inserts a file ref");
		assert.ok(!rows.some((line) => line.includes("src/util.ts")), "menu closes after insert");

		terminal.inputListener?.("\x03");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("@sr");
		rows = await waitForRows(terminal, (frame) => frame.some((line) => line.includes("src/")));
		assert.ok(rows.some((line) => line.includes("src/")), "directory is offered");

		// Tab 引用目录本身；右方向键才钻进去
		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ @src ")), "Tab inserts a directory ref");

		terminal.inputListener?.("\x03");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("@sr");
		rows = await waitForRows(terminal, (frame) => frame.some((line) => line.includes("src/")));

		terminal.inputListener?.("\x1b[C"); // 右方向键钻取
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ @src/")), "Right drills into the folder");
		assert.ok(rows.some((line) => line.includes("util.ts")), "children are listed after drill");

		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("@src/app.ts ")), "child file is inserted");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("@ 目录名带空格时仍能继续钻取", async () => {
		const root = workspaceFixture();
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run({ ...runtimeOf(), cwd: root });
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("@my");
		let rows = await waitForRows(terminal, (frame) => frame.some((line) => line.includes("my dir/")));
		assert.ok(rows.some((line) => line.includes("my dir/")), "spaced directory is offered");

		terminal.inputListener?.("\x1b[C");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ @my dir/")), "space stays inside the token");
		assert.ok(rows.some((line) => line.includes("note.txt")), "children are listed");

		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("@my dir/note.txt ")));

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});
});
