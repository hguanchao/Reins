import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TurnDriver } from "../../../src/agent/driver.ts";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import type { InteractiveRuntime } from "../../../src/tui/frontend.ts";
import { framesWith, lastFrameRows, MemoryTerminal, runtimeOf } from "./frontend-harness.ts";

/**
 * 前端集成测试——帧组装与输入框。
 *
 * 这些用例都从完整的 TerminalFrontend 跑起，只沿主题分文件：本文件看帧的组装（输入框边框、
 * 光标定位、快捷键条、运行状态行、审批面板）与提交路径（换行、续行、Esc 的语义）。
 */

/** 从整帧里取出输入框：底部边框带模型信息，向上找最近的一条顶边框。 */
function inputBox(rows: readonly string[]): {
	readonly top: string;
	readonly bottom: string;
	readonly body: readonly string[];
} {
	const bottomIndex = rows.findLastIndex(
		(line) => line.trimStart().startsWith("╰") && line.includes("m1"),
	);
	let topIndex = -1;
	for (let index = bottomIndex - 1; index >= 0; index -= 1) {
		if (rows[index].trimStart().startsWith("╭")) {
			topIndex = index;
			break;
		}
	}
	return {
		top: rows[topIndex] ?? "",
		bottom: rows[bottomIndex] ?? "",
		body: rows.slice(topIndex + 1, bottomIndex),
	};
}

describe("前端：帧与输入", () => {
	it("输入框是完整方框：上边框与嵌了信息的下边框", async () => {
		const { lines, styled } = await framesWith(24, 80);
		const visible = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const box = inputBox(visible);

		assert.ok(box.top, "top border");
		assert.ok(box.bottom, "bottom border");
		// 输入框缩进外边距：框体占 76 列，两侧各留 2 列
		assert.equal(box.top.trim().length, 76);
		assert.equal(box.bottom.trim().length, 76);
		assert.ok(box.top.includes("─"));
		assert.ok(box.bottom.includes("m1"), "model in the bottom border");
		assert.ok(box.bottom.includes(" · ask"), "approval mode in the bottom border");
		assert.ok(styled.some((line) => line.includes("╭") && line.includes("38;2;80;80;88")), "focused border color");
	});

	it("输入行左右有竖线，提示符与左边框直接相贴", async () => {
		const { lines } = await framesWith(24, 80);
		const editorRow = lines.find((line) => line.includes("❯"));
		assert.ok(editorRow, "editor row exists");
		const visible = editorRow!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
		assert.ok(visible.trimStart().startsWith("│"), "left border");
		assert.ok(visible.trimEnd().endsWith("│"), "right border");
		// 左边距(2) + 左边框后没有缩进格
		assert.equal(visible.indexOf("❯"), 3, "prompt right after the border");
	});

	it("输入框失焦时收成一行并显示占位提示", async () => {
		const terminal = new MemoryTerminal();
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.ok(!lastFrameRows(terminal.output).some((line) => line.includes("Build anything")));

		terminal.inputListener?.("\t"); // 焦点切到主区
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("Build anything")), "placeholder when unfocused");
		const box = inputBox(rows);
		assert.equal(
			box.body.filter((line) => line.trimStart().startsWith("│") && line.trimEnd().endsWith("│")).length,
			1,
			"editor collapses to one row",
		);

		terminal.quitFromScrollback();
		await running;
	});

	it("模型与审批方式嵌在下边框，顶部状态行只放位置与上下文", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const bottom = inputBox(visibleLines).bottom;

		assert.ok(bottom);
		assert.ok(bottom!.includes("m1"));
		assert.ok(bottom!.includes(" · ask"));
		// 顶部状态行放分支、目录与上下文占用；模型留在输入框下边框
		assert.ok(visibleLines[0].includes("⎇ main"), visibleLines[0]);
		assert.ok(visibleLines[0].includes("12.3k / 128.0k"), visibleLines[0]);
		assert.ok(!visibleLines[0].includes("m1"), "model is not duplicated in the top bar");
	});

	it("新会话首屏显示品牌与入口提示，提交后让给会话记录", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		assert.ok(visibleLines.some((line) => line.includes("REINS")), "wordmark");
		assert.ok(visibleLines.some((line) => line.includes("A terminal coding agent")), "tagline");
		assert.ok(visibleLines.some((line) => line.includes("@file")), "file hint");

		const terminal = new MemoryTerminal();
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: () => ({ run: async () => undefined }) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const rows = lastFrameRows(terminal.output);
		assert.ok(!rows.some((line) => line.includes("A terminal coding agent")), "welcome is gone");
		assert.ok(rows.some((line) => line.includes("❯ hello")), "conversation takes over");

		terminal.quit();
		await running;
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
		// 边距(2)+边框(1)+提示符(2)+输入内容(1)，从 1 开始计数
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
		const editorRows = inputBox(lastFrameRows(terminal.output)).body.filter((line) => {
			const text = line.trim();
			return text.startsWith("│") && text.endsWith("│");
		});
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
			inputBox(rows).body.filter((line) => line.trim().startsWith("│") && line.trim().endsWith("│")).length,
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

	it("底部快捷键条缩进外边距，与会话条目同列", async () => {
		const { lines } = await framesWith(24, 80);
		const visibleLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
		const hint = visibleLines.find((line) => line.includes("Enter:send"));
		assert.ok(hint, "key hint row exists");
		assert.ok(hint!.startsWith("  Enter:send"), "aligned with the outer padding");
	});

	it("运行状态行占输入框的内区：指示器落在提示符列，右缘收在右边框内侧", async () => {
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

		const visible = lastFrameRows(terminal.output);
		const status = visible.find((line) => line.includes("Thinking"));
		const editor = visible.find((line) => line.includes("❯") && line.trimStart().startsWith("│"));
		const bottom = inputBox(visible).bottom;
		assert.ok(status && editor && bottom, "行、输入框与下边框都在");
		assert.equal(status!.search(/\S/), editor!.indexOf("❯"), "指示器与输入框的提示符同列");
		assert.equal(status!.trimEnd().length, bottom!.trimEnd().length - 1, "右缘收在右边框内侧一格");
		assert.ok(status!.includes("⇣12.3k"), `右缘带上下文规模: ${status}`);

		releaseRun?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.quit();
		await running;
	});

	it("运行状态行跟着动作切换：思考、跑工具、作答", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		let emitEvent: ((event: AgentEvent) => void) | undefined;
		let releaseRun: (() => void) | undefined;
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) => {
				emitEvent = onEvent;
				return {
					run: async () => {
						onEvent({ type: "turn_start" });
						await new Promise<void>((resolve) => {
							releaseRun = resolve;
						});
					},
				} as unknown as TurnDriver;
			},
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			lastFrameRows(terminal.output).some((line) => line.includes("Thinking")),
			"回合开始是思考",
		);

		emitEvent?.({ type: "tool_start", callId: "c1", name: "Bash", args: {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 阶段耗时紧跟在动作后面，与整轮耗时分开
		assert.ok(
			lastFrameRows(terminal.output).some((line) => /Running Bash \d/.test(line)),
			"跑工具时显示动作与这一步的耗时",
		);

		emitEvent?.({ type: "text_delta", text: "hi" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			lastFrameRows(terminal.output).some((line) => line.includes("Responding")),
			"开始写答案后不再显示思考",
		);

		releaseRun?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.quit();
		await running;
	});

	it("运行中 Esc 只提示 Ctrl+C，不打断回合", async () => {
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

		assert.equal(aborted, false, "回合继续跑");
		assert.ok(
			lastFrameRows(terminal.output).some((line) => line.includes("Press Ctrl+C to cancel the turn")),
			"提示改按 Ctrl+C",
		);

		terminal.inputListener?.("\x03");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(aborted, true, "Ctrl+C 才打断回合");

		terminal.quit();
		await running;
	});

	it("Ctrl+S 暂存草稿并在顶边框标出，再按一次取回", async () => {
		const terminal = new MemoryTerminal();
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("draft text");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("\x13");
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("Stashed")), "top border marks the stash");
		assert.ok(!rows.some((line) => line.includes("❯ draft text")), "editor is cleared");

		terminal.inputListener?.("\x13");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ draft text")), "draft is restored");
		assert.ok(!rows.some((line) => line.includes("Stashed")), "stash marker is gone");

		terminal.quit();
		await running;
	});

	it("空闲时 Esc 连按两次才清空输入", async () => {
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
		const armed = lastFrameRows(terminal.output);
		assert.ok(armed.some((line) => line.includes("abc")), "第一次不清空");
		assert.ok(armed.some((line) => line.includes("press again to clear")), "提示再按一次");

		terminal.inputListener?.("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const cleared = lastFrameRows(terminal.output);
		assert.ok(!cleared.some((line) => line.includes("abc")), "input cleared");

		// 还是不退出:还能继续输入
		terminal.inputListener?.("z");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("z")), "still running");

		terminal.quit();
		await running;
	});

	it("退出要连按两次 Ctrl+D", async () => {
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 24, cols: 80 };
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x04");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			lastFrameRows(terminal.output).some((line) => line.includes("press again to quit")),
			"第一次只提示",
		);

		terminal.inputListener?.("\x04");
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

	it("接续旧会话时先把历史铺进会话区", async () => {
		const at = new Date(2026, 9, 18, 9, 30).getTime();
		const terminal = new MemoryTerminal();
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			session: {
				...runtimeOf().session,
				entries: 3,
				history: [
					{ kind: "user", text: "old question", at },
					{ kind: "assistant", text: "old answer", at },
					{ kind: "tool", name: "read", args: { path: "a.ts" }, output: "old output", isError: false, at },
				],
			},
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ old question")), "user message is replayed");
		assert.ok(rows.some((line) => line.includes("old answer")), "assistant message is replayed");
		assert.ok(rows.some((line) => line.includes("Read 1 file")), "tool call is replayed as a group");

		terminal.quit();
		await running;
	});

	it("顶部上下文占用条悬停时换成进度条", async () => {
		const terminal = new MemoryTerminal();
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtimeOf());
		await new Promise((resolve) => setTimeout(resolve, 0));

		let rows = lastFrameRows(terminal.output);
		assert.ok(rows[0].includes("12.3k / 128.0k"), rows[0]);
		const from = rows[0].indexOf("12.3k");
		terminal.inputListener?.(`\x1b[<35;${from + 1};1M`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows[0].includes("█") && rows[0].includes("░"), rows[0]);
		assert.ok(rows[0].endsWith("9.6%"), rows[0]);

		terminal.inputListener?.("\x1b[<35;10;10M");
		await new Promise((resolve) => setTimeout(resolve, 0));
		rows = lastFrameRows(terminal.output);
		assert.ok(rows[0].includes("12.3k / 128.0k"), "hover leaves the token form");

		terminal.quit();
		await running;
	});

	it("运行中提交的消息进入队列，这一轮结束后自动接着跑", async () => {
		const prompts: string[] = [];
		const releases: (() => void)[] = [];
		const terminal = new MemoryTerminal();
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			createDriver: (onEvent) =>
				({
					run: async (prompt: string) => {
						prompts.push(prompt);
						onEvent({ type: "turn_start" });
						await new Promise<void>((resolve) => releases.push(resolve));
						onEvent({ type: "run_end" });
					},
				}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("first\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("second\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		let rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("#1 second")), "queued message is listed");
		assert.ok(rows.some((line) => line.includes("1 queued")), "running row counts the queue");
		assert.deepEqual(prompts, ["first"], "the current turn keeps running");

		releases[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(prompts, ["first", "second"], "queued prompt starts after the turn");
		rows = lastFrameRows(terminal.output);
		assert.ok(rows.some((line) => line.includes("❯ second")), "queued prompt becomes a user turn");
		assert.ok(!rows.some((line) => line.includes("#1 second")), "queue row is gone");

		releases[1]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.quit();
		await running;
	});

	it("运行行上的 [↓] 回到末尾，[stop] 中止回合", async () => {
		let aborted = false;
		const terminal = new MemoryTerminal();
		terminal.sizeValue = { rows: 20, cols: 80 };
		const runtime: InteractiveRuntime = {
			...runtimeOf(),
			runCommand: async () => Array.from({ length: 40 }, (_, index) => `line ${index}`),
			createDriver: (onEvent) =>
				({
					run: async (_prompt: string, signal: AbortSignal) => {
						onEvent({ type: "turn_start" });
						await new Promise<void>((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									setTimeout(resolve, 30);
								},
								{ once: true },
							);
						});
						onEvent({ type: "aborted" });
					},
				}) as unknown as TurnDriver,
		};
		const frontend = new TerminalFrontend({ terminal, env: {} });
		const running = frontend.run(runtime);
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("/long\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		terminal.inputListener?.("hello\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		terminal.inputListener?.("\x1b[5~"); // PageUp：翻上去看历史
		await new Promise((resolve) => setTimeout(resolve, 0));
		let rows = lastFrameRows(terminal.output);
		let statusRow = rows.findIndex((line) => line.includes("[↓]") && line.includes("[stop]"));
		assert.ok(statusRow >= 0, "follow button appears while scrolled up");
		terminal.inputListener?.(`\x1b[<0;${rows[statusRow].indexOf("[↓]") + 1};${statusRow + 1}M`);
		terminal.inputListener?.(`\x1b[<0;${rows[statusRow].indexOf("[↓]") + 1};${statusRow + 1}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));

		rows = lastFrameRows(terminal.output);
		statusRow = rows.findIndex((line) => line.includes("[stop]"));
		assert.ok(statusRow >= 0);
		assert.ok(!rows[statusRow].includes("[↓]"), "following again hides the follow button");

		terminal.inputListener?.(`\x1b[<0;${rows[statusRow].indexOf("[stop]") + 1};${statusRow + 1}M`);
		terminal.inputListener?.(`\x1b[<0;${rows[statusRow].indexOf("[stop]") + 1};${statusRow + 1}m`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(aborted, true, "stop button aborts the turn");
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("Cancelling…")), "cancelling state is visible");

		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(lastFrameRows(terminal.output).some((line) => line.includes("Cancelled")), "turn ends as cancelled");

		terminal.quit();
		await running;
	});
});
