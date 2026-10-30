import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, exitTui, lastFrame, frameLines, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";
import { THEME } from "#src/tui/render/theme.ts";

describe("工具行渲染", () => {
	it("每行按自己的坐标写，滚动条列在内容之后单独重画", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({
				type: "text_delta",
				text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
			});
			t.mock.timers.tick(100);

			const frame = lastFrame(output);
			// 不再靠换行符顺推：一行的实际列宽由终端决定，顺推会让后面的行整体错位
			assert.equal(frame.includes("\r\n"), false);

			const rows = [...frame.matchAll(/\x1b\[(\d+);1H/g)].map((match) => Number(match[1]));
			assert.deepEqual(rows, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

			// 内容行写完之后，主区域的每一行都按自己的行号重画了一次最右列
			const gutter = [...frame.matchAll(/\x1b\[(\d+);40H/g)].map((match) => Number(match[1]));
			assert.deepEqual(gutter, [1, 2, 3, 4, 5, 6]);

			// 这一列里滑块是一整段，没有被内容带偏而断开
			const column = gutter.map((row) => {
				const at = frame.indexOf(`\x1b[${row};40H`);
				return plain(frame.slice(at)).charAt(`\x1b[${row};40H`.length);
			});
			const first = column.indexOf("█");
			assert.ok(first > 0);
			assert.equal(column.slice(first).join("").includes(" "), false);
			assert.equal(column.slice(0, first).includes("█"), false);
		} finally {
			exitTui(input);
		}
	});

	it("思考正文运行时显示最后五行，双击标题展开或收起", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const rowOf = (needle: string): number =>
			frameLines(output).findIndex((line) => plain(line).includes(needle)) + 1;
		const doubleClick = (row: number): void => {
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
		};

		try {
			input.emit("data", Buffer.from("你好\r"));
			agent.emit({ type: "reasoning_delta", text: "line1\nline2\nline3\n" });
			agent.emit({ type: "reasoning_delta", text: "line4\nline5\nline6\nline7" });
			t.mock.timers.tick(500);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("✻ Thinking…"));
			assert.ok(
				["line3", "line4", "line5", "line6", "line7"].every((line) => text.includes(line)),
			);
			assert.equal(text.includes("line1"), false);
			assert.equal(text.includes("line2"), false);

			// 双击 Thinking… 展开全文
			doubleClick(rowOf("Thinking…"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line1"));
			assert.ok(text.includes("line2"));

			// 再次双击回到最后五行
			doubleClick(rowOf("Thinking…"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);
			assert.ok(text.includes("line3"));

			// 结束：默认收起为标题
			agent.emit({ type: "text_delta", text: "你好，我能读写文件和跑命令。" });
			t.mock.timers.tick(100);
			const finished = frameLines(output);
			text = finished.map(plain).join("\n");
			assert.ok(text.includes("✻ Thought for 0.5s"));
			assert.equal(text.includes("line3"), false);
			assert.ok(
				finished.some(
					(line) => line.includes(THEME.textSubtle) && plain(line).includes("Thought for 0.5s"),
				),
			);

			// 双击 Thought for Xs 展开全文
			doubleClick(rowOf("Thought for 0.5s"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line1"));
			assert.ok(text.includes("line5"));

			// 再次双击收起
			doubleClick(rowOf("Thought for 0.5s"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);
			assert.ok(text.includes("Thought for 0.5s"));

			// 回答仍在摘要之后
			assert.ok(text.indexOf("Thought for 0.5s") < text.indexOf("你好，我能读写文件和跑命令。"));
		} finally {
			exitTui(input);
		}
	});

	it("bash 行只显示核心命令，双击展开完整命令", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			workspaceRoot: "/work",
		});

		const text = (): string => frameLines(output).map(plain).join("\n");
		const rowOf = (needle: string): number =>
			frameLines(output).findIndex((line) => plain(line).includes(needle)) + 1;
		const doubleClick = (row: number): void => {
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
		};

		try {
			input.emit("data", Buffer.from("跑测试\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "bash",
				args: { command: "cd /work && npm test 2>&1 | tail -5" },
			});
			agent.emit({ type: "tool_end", callId: "c1", name: "bash", isError: false, durationMs: 10, summary: "" });
			t.mock.timers.tick(100);

			// 折叠态：多余的工作根 cd 已剥掉，只剩核心命令与耗时
			let frame = text();
			assert.ok(frame.includes("› Bash  npm test (0.0s)"));
			assert.equal(frame.includes("cd /work"), false);

			doubleClick(rowOf("› Bash"));
			frame = text();
			assert.ok(frame.includes("cd /work && npm test 2>&1 | tail -5"));

			doubleClick(rowOf("◆ Bash"));
			frame = text();
			assert.equal(frame.includes("cd /work"), false);
			assert.ok(frame.includes("› Bash  npm test (0.0s)"));
		} finally {
			exitTui(input);
		}
	});

	it("工具成功不在对话流里留 done 行，失败仍显示", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑一下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts"));
			assert.ok(text.includes("Running Read..."));

			agent.emit({ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 12, summary: "A-BODY" });
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts"));
			assert.equal(text.includes('{"path"'), false);
			assert.equal(text.includes("done"), false);

			agent.emit({ type: "tool_start", callId: "c2", name: "bash", args: { command: "false" } });
			agent.emit({ type: "tool_end", callId: "c2", name: "bash", isError: true, durationMs: 3, summary: "exit 1" });
			t.mock.timers.tick(100);

			let lines = frameLines(output);
			text = lines.map(plain).join("\n");
			// 失败直接落在调用行上：显示命令与耗时，不再另起一行错误摘要
			assert.ok(text.includes("× Bash  false (0.0s)"));
			assert.equal(text.includes("× Bash  exit 1"), false);

			// 双击这一行展开完整命令和详细报错
			const failedRow = lines.findIndex((line) => plain(line).includes("× Bash"));
			assert.ok(failedRow >= 0);
			const row = failedRow + 1;
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			t.mock.timers.tick(100);

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("false"));
			assert.ok(text.includes("exit 1"));
		} finally {
			exitTui(input);
		}
	});

	it("组里的命令失败后摘回顶层可见", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑两条\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "first" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "ONE",
				content: "ONE",
			});
			agent.emit({ type: "tool_start", callId: "c2", name: "bash", args: { command: "second" } });
			agent.emit({ type: "tool_end", callId: "c2", name: "bash", isError: true, durationMs: 1, summary: "exit 1" });
			t.mock.timers.tick(100);

			const text = frameLines(output).map(plain).join("\n");
			// 失败的一条退回顶层错误行；组剩一条后不再保留组头
			assert.ok(text.includes("× Bash  second"));
			assert.ok(text.includes("Bash  first"));
			assert.equal(text.includes("Ran 1 command"), false);
			assert.equal(text.match(/× Bash/g)?.length, 1);
		} finally {
			exitTui(input);
		}
	});

	it("工具结束后把结构化结果指标挂到折叠行", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("读一下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 12,
				summary: "content",
				content: "content",
				details: { startLine: 1, endLine: 120, totalLines: 400 },
			});
			t.mock.timers.tick(100);

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read  a.ts (1-120 of 400)"));
		} finally {
			exitTui(input);
		}
	});

	it("失败的行与状态里的 Error 用错误色", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑个命令\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "false" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: true,
				durationMs: 3,
				summary: "exit 1",
			});
			agent.emit({ type: "error", message: "boom" });
			t.mock.timers.tick(100);

			const lines = frameLines(output);
			const failed = lines.find((line) => plain(line).includes("× Bash"));
			const error = lines.find((line) => plain(line).includes("× Error: boom"));
			const status = lines.find((line) => plain(line).includes("Error"));

			assert.ok(failed?.includes(THEME.error));
			assert.ok(error?.includes(THEME.error));
			assert.ok(status?.includes(THEME.error));
			// 已经不是「正在进行」了：状态行不该还用强调色，也不必扫光
			assert.equal(status?.includes(THEME.accent), false);
		} finally {
			exitTui(input);
		}
	});

	it("连续只读工具默认收起，双击组头展开", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hi\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({ type: "tool_end", callId: "c1", name: "read", isError: false, durationMs: 1, summary: "A-BODY" });
			agent.emit({ type: "tool_start", callId: "c2", name: "read", args: { path: "b.ts" } });
			t.mock.timers.tick(100);

			// 运行期就收起：组头说明读了什么，成员不占屏
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read 2 files"));
			assert.equal(text.includes("› Read  a.ts"), false);
			assert.equal(text.includes("› Read  b.ts"), false);

			await agent.finish();

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Read 2 files"));
			assert.equal(text.includes("› Read  a.ts"), false);

			// 双击组头展开，不必等下一轮
			const headerRow = frameLines(output).map(plain).findIndex((line) => line.includes("› Read 2 files")) + 1;
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◈ Read 2 files"));
			assert.ok(text.includes("› Read  a.ts"));
		} finally {
			exitTui(input);
		}
	});

	it("中止后清空状态行，只在对话流留下说明", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "aborted", cause: "user" });
			t.mock.timers.tick(100);

			const frame = frameLines(output);
			const text = frame.map(plain).join("\n");
			// 主动停下由对话流说明，状态行不再保留结局，也不再转圈
			assert.equal(text.includes("Stopping…"), false);
			assert.equal(text.includes("⠋"), false);

			// 对话流里留一条弱化色的说明，标出回答在这里被截断，且是使用者自己停下的
			const note = frame.find((line) => plain(line).includes("Turn stopped by you"));
			assert.ok(note);
			assert.equal(text.split("Turn stopped by you").length - 1, 1);
			assert.ok(note.includes(THEME.textSubtle));
			assert.equal(plain(note).includes("Error"), false);
			assert.equal(frame.some((line) => plain(line).includes("×")), false);
		} finally {
			exitTui(input);
		}
	});

	it("状态行区分写工具调用、等待子代理与等待模型", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));

			agent.emit({ type: "writing_tool_call", name: "read" });
			let status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Writing tool call…"));

			agent.emit({ type: "tool_start", callId: "s1", name: "subagent", args: { task: "检查一" } });
			agent.emit({ type: "tool_start", callId: "s2", name: "subagent", args: { task: "检查二" } });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for subagent…"));

			// 子代理内部的进度更新不能把状态改写成普通工具在跑
			agent.emit({ type: "tool_update", callId: "s1", text: "step 2/8" });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for subagent…"));

			// 并行派发时先结束一个，另一个还在跑，状态仍是等待子代理
			agent.emit({ type: "tool_end", callId: "s1", name: "subagent", isError: false, durationMs: 10, summary: "ok" });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for subagent…"));

			agent.emit({ type: "tool_end", callId: "s2", name: "subagent", isError: false, durationMs: 10, summary: "ok" });
			status = plain(frameLines(output)[7] ?? "");
			assert.ok(status.includes("Waiting for model…"));
		} finally {
			exitTui(input);
		}
	});

	it("运行中的命令行耗时逐秒递增，结束后定格", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const commandLine = (): string =>
			frameLines(output)
				.map(plain)
				.find((line) => line.includes("Bash  npm test")) ?? "";

		try {
			input.emit("data", Buffer.from("hi\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "npm test" } });
			t.mock.timers.tick(100);
			assert.ok(commandLine().includes("(0.0s)"));

			// 长命令跑到一半就能看出用了多久，不必等结果回来
			t.mock.timers.tick(2000);
			assert.ok(commandLine().includes("(2.0s)"));

			t.mock.timers.tick(3000);
			assert.ok(commandLine().includes("(5.0s)"));

			// 结果回来时按真实耗时定格，实时值不再参与
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 4200,
				summary: "ok",
				content: "ok",
			});
			t.mock.timers.tick(100);
			assert.ok(commandLine().includes("(4.2s)"));
			assert.equal(commandLine().includes("(5.0s)"), false);
		} finally {
			exitTui(input);
		}
	});
});
