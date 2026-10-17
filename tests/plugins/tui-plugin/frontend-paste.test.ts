import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TurnDriver } from "../../../src/agent/driver.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import { lastFrameRows, MemoryTerminal, runtimeOf, textClipboard } from "./frontend-harness.ts";

/**
 * 前端集成测试——剪贴板与粘贴 chip。
 *
 * Ctrl+V 读系统剪贴板后按内容分流：多行或很大的内容折成原子 chip，提交时再展开；Ctrl+Shift+V
 * 跳过 chip 直接内联；重粘贴同一段与双击 chip 都会把 chip 摊开。
 */

describe("前端：粘贴", () => {
	it("Ctrl+V 把多行剪贴板折成 chip，提交时展开完整内容", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = "one\ntwo\nthree\nfour";
		let received = "";
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () =>
				({
					run: async (prompt: string) => {
						received = prompt;
					},
				}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("[Pasted: 4 lines]")), "multi-line paste becomes a chip");
		assert.ok(!rows.some((line) => line.includes("one")), "chip hides the pasted body");

		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(received, content, "submit expands the chip");

		terminal.quit();
		await running;
	});

	it("Ctrl+Shift+V 内联粘贴，不生成 chip", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({
			terminal,
			env: {},
			clipboard: textClipboard(terminal, "one\ntwo\nthree\nfour"),
		});
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x1b[86;6u");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("one")), "inline paste shows the text");
		assert.ok(!rows.some((line) => line.includes("[Pasted:")), "no chip in inline mode");

		terminal.inputListener?.("\x03"); // 清空输入
		terminal.quit();
		await running;
	});

	it("再次粘贴同一段内容会把 chip 展开", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = "one\ntwo\nthree\nfour";
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("[Pasted: 4 lines]")));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(!rows.some((line) => line.includes("[Pasted:")), "chip is expanded");
		assert.ok(rows.some((line) => line.includes("one")) && rows.some((line) => line.includes("four")));

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("输入内容超过高度上限时内部滚动，整帧仍不超过终端高度", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x1b[86;6u"); // 内联粘贴
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.equal(rows.length, 24, "frame stays within the terminal height");
		assert.ok(rows.some((line) => line.includes("line 40")), "cursor end stays visible");
		assert.ok(!rows.some((line) => line.trim() === "line 1"), "top of the draft scrolls out");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("双击粘贴 chip 直接展开", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const content = "one\ntwo\nthree\nfour";
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: textClipboard(terminal, content) });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		const chipRow = rows.findIndex((line) => line.includes("[Pasted: 4 lines]"));
		assert.ok(chipRow >= 0, "chip is visible");
		const chipCol = rows[chipRow].indexOf("[Pasted: 4 lines]") + 1;

		for (let click = 0; click < 2; click += 1) {
			terminal.inputListener?.(`\x1b[<0;${chipCol};${chipRow + 1}M`);
			terminal.inputListener?.(`\x1b[<0;${chipCol};${chipRow + 1}m`);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const expanded = lastFrameRows(terminal.output);
		assert.ok(!expanded.some((line) => line.includes("[Pasted:")), "double-click expands the chip");
		assert.ok(expanded.some((line) => line.includes("one")) && expanded.some((line) => line.includes("four")));

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});
});
