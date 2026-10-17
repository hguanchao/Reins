import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TurnDriver } from "../../../src/agent/driver.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import { lastFrameRows, MemoryTerminal, osc52Clipboard, runtimeOf } from "./frontend-harness.ts";

/**
 * 前端集成测试——会话区交互。
 *
 * 会话记录按块排版后的三类动作都在这里：悬停（轨道刻度、时间戳）、块操作（单击选中、双击
 * 折叠、复制按钮、键盘折叠与复制）以及滚动与拖选（滚动条、拖选即复制、主区焦点下的中止键
 * 与审批弹窗）。
 */

describe("前端：会话区交互", () => {
	it("悬停轨道刻度显示对应回合的预览", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("first\r");
		await new Promise((resolve) => setTimeout(resolve, 10));
		terminal.inputListener?.("second\r");
		await new Promise((resolve) => setTimeout(resolve, 10));

		const rows = lastFrameRows(terminal.output);
		const ticks = rows
			.map((line, index) => ({ line, index }))
			.filter(
				({ line }) =>
					(line[78] === "─" || line[78] === "━") && line[79] !== "╮" && line[79] !== "╯",
			);
		assert.ok(ticks.length >= 2, "two turn ticks are visible");
		const hover = ticks.at(-1)!;

		terminal.inputListener?.(`\x1b[<35;79;${hover.index + 1}M`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const footer = lastFrameRows(terminal.output).at(-1) ?? "";
		assert.ok(footer.includes("Turn 2"), footer);
		assert.ok(footer.includes("second"), footer);

		terminal.inputListener?.("\x1b[<35;10;1M");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(!(lastFrameRows(terminal.output).at(-1) ?? "").includes("Turn 2"), "hover clears");

		terminal.quit();
		await running;
	});

	it("悬停时间戳时在底部展开完整日期", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 10));

		const rows = lastFrameRows(terminal.output);
		const row = rows.findIndex((line) => /\d{1,2}:\d{2} (AM|PM)/.test(line));
		assert.ok(row >= 0, "timestamp is visible");
		const col = rows[row].search(/\d{1,2}:\d{2} (AM|PM)/) + 1;
		terminal.inputListener?.(`\x1b[<35;${col};${row + 1}M`);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const footer = lastFrameRows(terminal.output).at(-1) ?? "";
		assert.match(footer, /\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (AM|PM)/, footer);

		terminal.inputListener?.("\x1b[<35;10;1M");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(!(lastFrameRows(terminal.output).at(-1) ?? "").includes("▸"), "timestamp hover clears");

		terminal.quit();
		await running;
	});

	it("用户消息块按条目布局排列并带 ❯ 前缀", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hi\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const message = lastFrameRows(terminal.output).find((line) => line.startsWith("     ❯ hi"));
		assert.ok(message, "message starts after the block chrome");
		assert.equal(message!.length, 80, "band spans the full entry width plus gutter");

		terminal.quit();
		await running;
	});

	it("内容超过一屏时显示滚动条，点轨道可以跳到顶部", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			runCommand: async () => Array.from({ length: 40 }, (_, index) => `line ${index}`),
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/long\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		let rows = lastFrameRows(terminal.output).slice(0, 19);
		assert.ok(rows.some((line) => line.endsWith("█")), "thumb shown");
		assert.ok(rows.some((line) => line.endsWith("│")), "track shown");

		// 最右一列是滚动条：点顶端轨道，滑块回到顶部
		terminal.inputListener?.("\x1b[<0;80;1M");
		terminal.inputListener?.("\x1b[<0;80;1m");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output).slice(0, 19);
		assert.ok(rows[0].endsWith("█"), "thumb moved to top");

		terminal.quit();
		await running;
	});

	it("鼠标拖选后释放，文本经 OSC 52 写入剪贴板", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: osc52Clipboard(terminal) });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		// 用户消息在第二行（❯ hello）：正文从第 5 列开始，从 h 拖到第二个 l
		terminal.inputListener?.("\x1b[<0;8;2M");
		terminal.inputListener?.("\x1b[<32;11;2M");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(terminal.output.includes("\x1b[7;") || terminal.output.includes("\x1b[7m"), "selection is highlighted");

		terminal.inputListener?.("\x1b[<0;11;2m");
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.ok(terminal.output.includes("\x1b]52;c;aGVsbA=="), "copied selected text");
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("Copied! (4 chars, 1 line)")));

		terminal.quit();
		await running;
	});

	it("单击选中块，双击折叠/展开，主区可用键盘折叠", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => ({
				run: async () => {
					onEvent({ type: "turn_start" });
					onEvent({ type: "tool_start", callId: "t1", name: "Read", args: { path: "a.ts" } });
					onEvent({ type: "tool_update", callId: "t1", text: "line one\nline two" });
					onEvent({
						type: "tool_end",
						callId: "t1",
						name: "Read",
						isError: false,
						durationMs: 10,
						summary: "ok",
					});
					onEvent({ type: "run_end" });
				},
			}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {}, clipboard: osc52Clipboard(terminal) });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("run\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const toolRow = lastFrameRows(terminal.output).findIndex((line) => line.includes("◈ Read 1 file"));
		assert.ok(toolRow >= 0, "tool group header is visible");
		const clickRow = toolRow + 1; // 鼠标坐标从 1 开始

		// 单击：选中块并画选中框
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const selected = lastFrameRows(terminal.output);
		assert.ok(selected.some((line) => line.trimStart().startsWith("┌")), "selection box top");
		assert.ok(selected.some((line) => line.trimStart().startsWith("└")), "selection box bottom");
		assert.ok(!selected.some((line) => line.includes("line one")), "tool group collapsed");

		// 选中块右上角的复制按钮
		const iconRow = selected.findIndex((line) => line.includes("⧉"));
		assert.ok(iconRow >= 0, "copy icon is visible");
		const iconCol = selected[iconRow].indexOf("⧉") + 1;
		terminal.inputListener?.(`\x1b[<0;${iconCol};${iconRow + 1}M`);
		terminal.inputListener?.(`\x1b[<0;${iconCol};${iconRow + 1}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const iconCopy = [...terminal.output.matchAll(/(?:\x1b\]52;c;)([^\x07]*)\x07/g)].at(-1);
		assert.ok(iconCopy, "copy icon writes the clipboard");
		assert.ok(
			Buffer.from(iconCopy[1], "base64").toString("utf8").includes("line one\nline two"),
			"copy icon copies the whole block",
		);

		// 300ms 内第二次按下：展开组，成员先以一行摘要出现
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${clickRow}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const expanded = lastFrameRows(terminal.output);
		assert.ok(expanded.some((line) => line.includes("◆ Read a.ts")), "group expands to member rows");
		assert.ok(!expanded.some((line) => line.includes("line one")), "member stays collapsed");

		// 双击成员：展开这个工具的完整输出
		const memberRow = lastFrameRows(terminal.output).findIndex((line) => line.includes("◆ Read a.ts"));
		assert.ok(memberRow >= 0, "member row exists");
		const memberClickRow = memberRow + 1;
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}m`);
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}M`);
		terminal.inputListener?.(`\x1b[<0;6;${memberClickRow}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			lastFrameRows(terminal.output).some((line) => line.includes("line one")),
			"double-click expands the member",
		);

		// 焦点已在主区：e 收起成员
		terminal.inputListener?.("e");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const folded = lastFrameRows(terminal.output);
		assert.ok(!folded.some((line) => line.includes("line one")), "keyboard fold");

		// y 复制成员的完整正文（折叠状态也复制全部）
		terminal.inputListener?.("y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const copy = /(?:\x1b\]52;c;)([^\x07]*)\x07/.exec(terminal.output);
		assert.ok(copy, "clipboard sequence written");
		assert.ok(Buffer.from(copy[1], "base64").toString("utf8").includes("line one\nline two"), "y copies the member body");

		// Y 只复制元信息（工具名与参数）
		terminal.inputListener?.("Y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const sequences = [...terminal.output.matchAll(/(?:\x1b\]52;c;)([^\x07]*)\x07/g)];
		const meta = sequences.at(-1);
		assert.ok(meta, "metadata copy sequence written");
		assert.equal(Buffer.from(meta[1], "base64").toString("utf8"), "Read a.ts");

		// Tab 回输入框，继续输入
		terminal.inputListener?.("\t");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("x");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("❯ x")), "prompt accepts input");

		terminal.inputListener?.("\x03");
		terminal.quit();
		await running;
	});

	it("主区焦点下 Esc 与 Ctrl+C 都能中止运行中的回合", async () => {
		for (const key of ["\x1b", "\x03"]) {
			let aborted = false;
			const terminal = new MemoryTerminal();
			terminal.sizeValue = { rows: 24, cols: 80 };
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
			// 点击用户消息块，把焦点切到主区
			terminal.inputListener?.("\x1b[<0;6;2M");
			terminal.inputListener?.("\x1b[<0;6;2m");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.ok(
				lastFrameRows(terminal.output).some((line) => line.includes("j/k:entry")),
				"scrollback focused",
			);

			terminal.inputListener?.(key);
			await new Promise((resolve) => setTimeout(resolve, key === "\x1b" ? 50 : 0));
			assert.equal(aborted, true, key === "\x1b" ? "aborted by Esc" : "aborted by Ctrl+C");

			terminal.quit();
			await running;
		}
	});

	it("审批弹窗在主区焦点下显示，Esc 与 Ctrl+C 都拒绝并中止", async () => {
		for (const key of ["\x1b", "\x03"]) {
			let aborted = false;
			let confirmer: ((question: string, detail: string) => Promise<boolean>) | undefined;
			const terminal = new MemoryTerminal();
			terminal.sizeValue = { rows: 24, cols: 80 };
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
				setConfirmer: (next) => {
					confirmer = next;
				},
			};
			const frontend = new TerminalFrontend({ terminal, env: {} });
			const running = frontend.run(runtime);
			await new Promise((resolve) => setTimeout(resolve, 0));

			terminal.inputListener?.("hello\r");
			await new Promise((resolve) => setTimeout(resolve, 0));
			terminal.inputListener?.("\x1b[<0;6;2M");
			terminal.inputListener?.("\x1b[<0;6;2m");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const decision = confirmer?.("Allow Bash to run?", "{}");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.ok(
				lastFrameRows(terminal.output).some((line) => line.includes("Allow Bash to run?")),
				"dialog stays visible in scrollback focus",
			);

			terminal.inputListener?.(key);
			await new Promise((resolve) => setTimeout(resolve, key === "\x1b" ? 50 : 0));
			assert.equal(await decision, false, "dialog denied");
			assert.equal(aborted, true, "turn aborted");
			assert.ok(
				!lastFrameRows(terminal.output).some((line) => line.includes("Allow Bash to run?")),
				"dialog closed",
			);

			terminal.quit();
			await running;
		}
	});
});
