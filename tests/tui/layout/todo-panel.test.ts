import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, SESSION_ITEMS, exitTui, rawFrame, frameLines, cursorAt, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";

describe("任务面板", () => {
	it("tool_start 只更新常驻面板,运行行转圈与扫光,回合结束回静态", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: {
					explanation: "开工",
					todos: [
						{ content: "写工具", status: "completed" },
						{ content: "渲染卡片", status: "in_progress" },
					],
				},
			});
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "todo",
				isError: false,
				durationMs: 1,
				summary: "Task list updated: 1 of 2 done.",
				content: "Task list updated: 1 of 2 done.",
			});

			let text = frameLines(output).map(plain).join("\n");
			// 卡片只在常驻面板出现一次;头行汇总计数,不再重复当前任务名
			assert.equal(text.split("› Tasks  1 running · 1 done").length - 1, 1);
			assert.ok(text.includes("● Task 1  写工具"));
			assert.ok(text.includes("⠋ Task 2  渲染卡片"));
			assert.equal(text.includes("开工"), false);

			// 运行期间:转圈与扫光落在当前任务行
			const runningRaw = frameLines(output).find((line) => plain(line).includes("Task 2")) ?? "";
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(plain(runningRaw)));
			assert.ok((runningRaw.match(/\x1b\[38;2;/g) ?? []).length > 1);

			await agent.finish();

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◐ Task 2  渲染卡片"));
			assert.equal(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("参数形状不对时退回普通工具行,校验错误能挂上", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "todo", args: { todos: "nope" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "todo",
				isError: true,
				durationMs: 1,
				summary: "Arguments must be an object",
				content: "Arguments must be an object, got string",
			});

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("× Todo"));
			assert.equal(text.includes("› Tasks"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("超过五条默认收起:头行显示计数,双击展开全部条目,再双击收起", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: {
					todos: Array.from({ length: 6 }, (_, index) => ({
						content: `任务${index + 1}`,
						status: index === 2 ? "in_progress" : "pending",
					})),
				},
			});

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Tasks  1 running · 5 pending"));
			assert.equal(text.includes("○ Task 1"), false);
			// 运行中的折叠头行带转圈任务名
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 任务3/.test(text));

			const headerRow = (): number =>
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("Tasks")) + 1;
			let row = headerRow();
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("○ Task 1  任务1"));
			// 展开态的进行中行仍是转圈(回合还在运行)
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Task 3  任务3/.test(text));

			// 面板变高后头行上移,重新取行号再双击
			row = headerRow();
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("○ Task 1"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("同一任务跨卡片更新时耗时继承,不重置", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			// 六条任务默认收起:头行显示进行中的任务 A 与从 0 起算的耗时
			const list = (active: string, done: string) => [
				{ content: "任务A", status: active },
				{ content: "任务B", status: done },
				...Array.from({ length: 4 }, (_, index) => ({
					content: `任务${index + 3}`,
					status: "pending",
				})),
			];
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: list("in_progress", "pending") },
			});
			let header = frameLines(output)
				.map(plain)
				.findLast((line) => line.includes("Tasks")) ?? "";
			assert.ok(header.includes("任务A"));
			assert.ok(/0\.0s/.test(header), `首张卡片耗时从 0 起算:${header}`);

			// 又过 5 秒,模型更新列表但任务 A 仍在进行:计时应继承,显示 5 秒而非重置为 0
			t.mock.timers.tick(5_000);
			agent.emit({
				type: "tool_start",
				callId: "c2",
				name: "todo",
				args: { todos: list("in_progress", "pending") },
			});
			header = frameLines(output)
				.map(plain)
				.findLast((line) => line.includes("Tasks")) ?? "";
			assert.ok(/5\.0s/.test(header), `同一任务跨更新继承计时:${header}`);

			// 换了进行中任务:计时重新从 0 起算
			t.mock.timers.tick(3_000);
			agent.emit({
				type: "tool_start",
				callId: "c3",
				name: "todo",
				args: { todos: list("completed", "in_progress") },
			});
			header = frameLines(output)
				.map(plain)
				.findLast((line) => line.includes("Tasks")) ?? "";
			assert.ok(header.includes("任务B"));
			assert.ok(/0\.0s/.test(header), `换任务后计时重置:${header}`);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("todo 调用后面板常驻:回合结束不消失,头行回静态,翻新计数", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "completed" }, { content: "渲染卡片", status: "in_progress" }] },
			});

			let text = frameLines(output).map(plain).join("\n");
			// 卡片只在面板出现:头行唯一,条目也跟着面板走
			assert.equal(text.split("› Tasks  1 running · 1 done").length - 1, 1);
			assert.equal(text.split("● Task 1  写工具").length - 1, 1);

			await agent.finish();

			// 回合结束:面板仍在(跨回合),运行行回静态,不再有转圈
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Tasks  1 running · 1 done"));
			assert.equal(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("续聊时用历史里的任务表恢复面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			history: [{ prompt: "old work", response: ["old answer"] }],
			historyTodo: {
				kind: "todo",
				items: [
					{ content: "写工具", status: "completed" },
					{ content: "补测试", status: "pending" },
				],
			},
			stdin: input,
			stdout: output,
		});

		try {
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.split("› Tasks  1 done · 1 pending").length - 1, 1);
			assert.ok(text.includes("● Task 1  写工具"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("切换会话时面板换成新会话的任务表", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			historyTodo: {
				kind: "todo",
				items: [{ content: "旧任务", status: "in_progress" }],
			},
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({
					changed: true,
					history: [],
					todo: { kind: "todo", items: [{ content: "新任务", status: "pending" }] },
					warnings: [],
				}),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("○ Task 1  新任务"));
			assert.equal(text.includes("旧任务"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("全部完成后从面板移出,整张卡落到对话流", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "completed" }, { content: "渲染卡片", status: "completed" }] },
			});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			// 收尾卡只在对话流出现一次,面板同时退出
			assert.equal(text.split("› Tasks  2 done").length - 1, 1);
			assert.equal(text.split("● Task 1  写工具").length - 1, 1);
			assert.ok(text.includes("● Task 2  渲染卡片"));

			// 新任务开始后,历史里的收尾卡仍在;面板换成新的未收尾表
			agent.emit({
				type: "tool_start",
				callId: "c2",
				name: "todo",
				args: { todos: [{ content: "下一步", status: "in_progress" }] },
			});
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.split("› Tasks  2 done").length - 1, 1);
			assert.ok(text.includes("› Tasks  1 running"));
			assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Task 1  下一步/.test(text));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("清空未收尾的任务表后面板消失,对话流不留卡", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "in_progress" }] },
			});
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).map(plain).join("\n").includes("› Tasks  1 running"));

			agent.emit({
				type: "tool_start",
				callId: "c2",
				name: "todo",
				args: { todos: [] },
			});
			t.mock.timers.tick(100);

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("› Tasks"), false);
			assert.equal(text.includes("写工具"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板出现后光标仍在输入行,不落到面板最后一行", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: {
					todos: [
						{ content: "统计 src 各目录的文件数与行数", status: "in_progress" },
						{ content: "找出最大的三个文件", status: "pending" },
						{ content: "汇总报告", status: "pending" },
					],
				},
			});
			t.mock.timers.tick(100);

			const lines = frameLines(output).map(plain);
			// 24 行终端:面板 4 行(头行 + 3 条目)占 15-18 行,输入行被顶到第 22 行。
			// 输入行若只按「主区域高度 + 页脚偏移」算,会落到面板最后一条上,看起来像凭空一根竖线
			const panelLast = lines.findLastIndex((line) => line.includes("汇总报告")) + 1;
			const inputRow = lines.findIndex((line) => line.trimEnd() === " ›") + 1;
			assert.equal(panelLast, 18);
			assert.equal(inputRow, 22);
			assert.ok(cursorAt(output, inputRow, 4));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("点击面板下方的输入框仍能把焦点收回来", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "todo",
				args: { todos: [{ content: "写工具", status: "in_progress" }] },
			});
			t.mock.timers.tick(100);

			const lines = frameLines(output).map(plain);
			const inputRow = lines.findIndex((line) => line.trimEnd() === " ›") + 1;
			const panelRow = lines.findLastIndex((line) => line.includes("写工具")) + 1;

			// 点面板那一行:面板不是输入框,焦点交出去,输入框变暗
			input.emit("data", Buffer.from(`\x1b[<0;5;${panelRow}M`));
			assert.equal(rawFrame(output).includes("\x1b[?25h"), false);

			// 点回输入行:焦点恢复,光标重新出现
			input.emit("data", Buffer.from(`\x1b[<0;5;${inputRow}M`));
			assert.ok(cursorAt(output, inputRow, 4));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
