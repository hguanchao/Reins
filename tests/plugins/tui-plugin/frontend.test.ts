import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TurnDriver } from "../../../src/agent/driver.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import { framesWith, lastFrameRows, MemoryTerminal, runtimeOf } from "./frontend-harness.ts";

/**
 * 前端集成测试——帧组装与输入框。
 *
 * 这些用例都从完整的 TerminalFrontend 跑起，只沿主题分文件：本文件看帧的组装（输入框边框、
 * 光标定位、快捷键条、运行状态行、审批面板）与提交路径（换行、续行、Esc 的语义）。
 */

describe("前端：帧与输入", () => {
	it("输入框是完整方框：上边框与嵌了信息的下边框", async () => {
		const { lines } = await framesWith(24, 80);
		const visible = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const top = visible.find((line) => line.startsWith("╭") && line.endsWith("╮"));
		const bottom = visible.find((line) => line.startsWith("╰") && line.endsWith("╯"));

		assert.ok(top, "top border");
		assert.ok(bottom, "bottom border");
		assert.equal(top!.length, 80);
		assert.equal(bottom!.length, 80);
		assert.ok(top!.includes("─"));
		assert.ok(bottom!.includes("m1"), "model in the bottom border");
		assert.ok(bottom!.includes("approval=ask"), "approval mode in the bottom border");
		assert.ok(lines.some((line) => line.includes("╭") && line.includes("38;2;80;80;88")), "focused border color");
	});

	it("输入行左右有竖线，提示符在边框和内边距之后", async () => {
		const { lines } = await framesWith(24, 80);
		const editorRow = lines.find((line) => line.includes("❯"));
		assert.ok(editorRow, "editor row exists");
		const visible = editorRow!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
		assert.ok(visible.startsWith("│"), "left border");
		assert.ok(visible.endsWith("│"), "right border");
		assert.equal(visible.indexOf("❯"), 3, "border plus two padding columns");
	});

	it("模型与审批方式嵌在下边框，顶部没有单独状态条", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const bottom = visibleLines.find((line) => line.startsWith("╰") && line.endsWith("╯"));

		assert.ok(bottom);
		assert.ok(bottom!.includes("m1"));
		assert.ok(bottom!.includes("approval=ask"));
		// 第一行是会话区，不是单独的头部状态条
		assert.ok(!visibleLines[0].includes("p/m1"));
	});

	it("没有首屏欢迎:标题、提示语、菜单、Ready 一概不出现", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		assert.ok(!visibleLines.some((line) => line.includes("Reins")), "no title");
		assert.ok(!visibleLines.some((line) => line.includes("Type a message")), "no hint line");
		assert.ok(!visibleLines.some((line) => line.includes("Commands")), "no menu");
		assert.ok(!visibleLines.some((line) => line.includes("Ready")), "no top bar");
	});

	it("输入时光标列落在提示符之后:屏幕列 = 提示符 + 输入位置", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 输入一个字母,再看最后一帧里的光标绝对定位
		terminal.inputListener?.("a");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const frame = terminal.output;
		const lastFrame = frame.slice(frame.lastIndexOf("\x1b[H"));
		const anchorMatch = /(?:\x1b\[)(\d+);(\d+)H(?!.*\x1b\[\d+;\d+H)/.exec(lastFrame);
		assert.ok(anchorMatch, "cursor positioned");
		// 边框(1)+内边距(2)+提示符(2)+输入内容(1)，从 1 开始计数
		assert.equal(anchorMatch[2], "7");
		// 清空再退出:Ctrl+D 只在空输入时退出
		terminal.inputListener?.("\x7f");
		terminal.quit();
		await running;
	});

	it("输入框支持 Ctrl+J 换行", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("a\nb");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const editorRows = lastFrameRows(terminal.output).filter(
			(line) => line.startsWith("│") && line.endsWith("│"),
		);
		assert.equal(editorRows.length, 2, "editor grows to two rows");
		assert.ok(editorRows[0].includes("❯ a"));
		assert.ok(editorRows[1].includes("b"));

		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ a")), "multiline message committed");
		assert.ok(rows.some((line) => line.includes("  b")), "second line kept");

		terminal.quit();
		await running;
	});

	it("反斜杠续行先换行，补齐后再发送", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("abc\\");
		terminal.inputListener?.("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		assert.equal(
			rows.filter((line) => line.startsWith("│") && line.endsWith("│")).length,
			2,
			"continuation keeps two editor rows",
		);
		assert.ok(rows.some((line) => line.includes("❯ abc")));
		assert.ok(!rows.some((line) => line.includes("  abc")), "nothing committed yet");

		terminal.inputListener?.("def\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ abc")), "first line committed");
		assert.ok(rows.some((line) => line.includes("  def")), "continuation line committed");

		terminal.quit();
		await running;
	});

	it("底部快捷键条从第一列开始", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const hint = visibleLines.find((line) => line.includes("Enter:send"));
		assert.ok(hint, "key hint row exists");
		assert.ok(hint!.startsWith("Enter:send"), "no left padding");
	});

	it("运行状态行从第一列开始", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let releaseRun: (() => void) | undefined;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => ({
				run: async () => {
					onEvent({ type: "turn_start" });
					await new Promise<void>((resolve) => {
						releaseRun = resolve;
					});
				},
			}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const frame = terminal.output;
		const visible = lastFrameRows(frame);
		const status = visible.find((line) => line.includes("Thinking"));
		assert.ok(status, "running row exists");
		assert.ok(!status!.startsWith(" "), "spinner at the first column");

		releaseRun?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.quit();
		await running;
	});

	it("运行中按 Esc 中止这一轮", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let aborted = false;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => ({
				run: async (_prompt: string, signal: AbortSignal) => {
					onEvent({ type: "turn_start" });
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								resolve();
							},
							{ once: true },
						);
					});
				},
			}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 单独的 ESC 要等一小会儿，确认它不是某个转义序列的开头
		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(aborted, true, "turn aborted by Esc");

		terminal.quit();
		await running;
	});

	it("空闲时按 Esc 清空输入，界面继续运行", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("abc");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("abc")), "text entered");

		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const cleared = lastFrameRows(terminal.output);
		assert.ok(!cleared.some((line) => line.includes("abc")), "input cleared");
		const editor = cleared.find((line) => line.startsWith("│") && line.includes("❯"));
		assert.ok(editor, "prompt is empty");

		// Esc 不退出:还能继续输入
		terminal.inputListener?.("z");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("z")), "still running");

		terminal.inputListener?.("\x03"); // Ctrl+C 清空输入
		terminal.quit();
		await running;
	});

	it("审批面板替换输入区，选项纵向排列", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let confirmer: ((question: string, detail: string) => Promise<boolean>) | undefined;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			setConfirmer: (next) => {
				confirmer = next;
			},
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const decision = confirmer?.("Allow Bash to run?", '{\n  "command": "npm test"\n}');
		await new Promise((resolve) => setTimeout(resolve, 0));

		const visible = lastFrameRows(terminal.output);
		assert.ok(visible.some((line) => line.includes("Allow Bash to run?")), "question is the panel title");
		assert.ok(visible.some((line) => line.includes("npm test")), "detail shown without raw JSON");
		assert.ok(!visible.some((line) => line.includes('"command"')), "no JSON in the panel");
		assert.ok(!visible.some((line) => line.includes("Approval required")), "no bordered popup title");

		assert.ok(visible.some((line) => line.includes("1 (●) Allow")), "allow option is focused");
		assert.ok(visible.some((line) => line.includes("2 (○) Deny")), "options are vertical");
		assert.ok(visible.some((line) => line.includes("↑/↓:select")), "footer shows dialog keys");

		const rules = visible.filter((line) => /^─+$/.test(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")));
		assert.equal(rules.length, 0, "input box is replaced by the permission panel");

		terminal.inputListener?.("2");
		assert.equal(await decision, false);
		terminal.quit();
		await running;
	});
});
