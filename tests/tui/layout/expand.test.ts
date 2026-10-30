import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, exitTui, frameLines, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";

describe("对话流展开", () => {
	it("Ctrl+E 展开最近思考区块", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "reasoning_delta", text: "line1\nline2\nline3\nline4\nline5\nline6" });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);

			input.emit("data", Buffer.from("\x05"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("line1"));

			input.emit("data", Buffer.from("\x05"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("line1"), false);
		} finally {
			exitTui(input);
		}
	});

	it("双击较早回合里的工具行也能展开", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			// 第一轮：留下一条可展开的工具结果，回合结束后它成为「较早的回合」
			input.emit("data", Buffer.from("first\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "old-command" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "OLD-BODY",
				content: "OLD-BODY",
			});
			await agent.finish();
			t.mock.timers.tick(100);

			// 第二轮：让第一轮进入前缀缓存
			input.emit("data", Buffer.from("second\r"));
			agent.emit({ type: "text_delta", text: "second answer" });
			await agent.finish();
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("OLD-BODY"), false);

			const row = frameLines(output).map(plain).findIndex((line) => line.includes("Bash")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("OLD-BODY"));
		} finally {
			exitTui(input);
		}
	});

	it("Ctrl+O 展开最近成功工具结果", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "RESULT-BODY",
				content: "RESULT-BODY",
			});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("RESULT-BODY"), false);

			input.emit("data", Buffer.from("\x0f"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("RESULT-BODY"));

			input.emit("data", Buffer.from("\x0f"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("RESULT-BODY"), false);
		} finally {
			exitTui(input);
		}
	});

	it("空结果按 Ctrl+O 不打开空色带", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "true" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "",
				content: "",
			});
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from("\x0f"));
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("(no output)"), false);
		} finally {
			exitTui(input);
		}
	});

	it("双击展开后再按 Ctrl+O，内容不会铺两遍", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const count = (text: string): number => text.split("ONLY-ONCE").length - 1;
		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "ONLY-ONCE",
				content: "ONLY-ONCE",
			});
			t.mock.timers.tick(100);

			const row = frameLines(output).map(plain).findIndex((line) => line.includes("Read")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			assert.equal(count(frameLines(output).map(plain).join("\n")), 1);

			// 再按 Ctrl+O：切到结果色带，同一份内容仍然只出现一次
			input.emit("data", Buffer.from("\x0f"));
			assert.equal(count(frameLines(output).map(plain).join("\n")), 1);
		} finally {
			exitTui(input);
		}
	});

	it("Ctrl+O 可展开收起工具组里的结果", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "A-BODY",
				content: "A-BODY",
			});
			agent.emit({ type: "tool_start", callId: "c2", name: "read", args: { path: "b.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c2",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "B-BODY",
				content: "B-BODY",
			});
			t.mock.timers.tick(100);
			await agent.finish();

			let text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("B-BODY"), false);

			input.emit("data", Buffer.from("\x0f"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("B-BODY"));
		} finally {
			exitTui(input);
		}
	});

	it("连续命令成组，运行期就收起；展开后回合结束再收起", async (t) => {
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
			agent.emit({
				type: "tool_end",
				callId: "c2",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "TWO",
				content: "TWO",
			});
			t.mock.timers.tick(100);

			// 运行期组头就已经出现并收起：成员不占屏，双击才展开
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Ran 2 commands"));
			assert.equal(text.includes("Bash  first"), false);
			assert.equal(text.includes("ONE"), false);

			// 双击组头展开成员，结果仍收在成员行里
			const headerRow =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("› Ran 2 commands")) + 1;
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◈ Ran 2 commands"));
			assert.ok(text.includes("Bash  first"));
			assert.ok(text.includes("Bash  second"));
			assert.equal(text.includes("ONE"), false);

			await agent.finish();
			t.mock.timers.tick(100);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Ran 2 commands"));
			assert.equal(text.includes("Bash  first"), false);
		} finally {
			exitTui(input);
		}
	});

	it("命令没被截短时，双击仍能展开它的输出", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("跑一下\r"));
			agent.emit({
				type: "tool_start",
				callId: "c1",
				name: "bash",
				args: { command: "python bubble_sort.py" },
			});
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 264,
				summary: "SORTED-OUTPUT",
				content: "SORTED-OUTPUT",
			});
			t.mock.timers.tick(100);

			// 结果默认不展开：这一行折叠时只显示命令与耗时
			assert.equal(frameLines(output).map(plain).join("\n").includes("SORTED-OUTPUT"), false);

			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("Bash")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			const expanded = frameLines(output).map(plain).join("\n");
			assert.ok(expanded.includes("SORTED-OUTPUT"));
			// 行首换成展开标记，不再写着「折叠着」
			assert.ok(expanded.includes("◆ Bash"));

			// 再双击一次收起
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			assert.equal(frameLines(output).map(plain).join("\n").includes("SORTED-OUTPUT"), false);
		} finally {
			exitTui(input);
		}
	});

	it("双击展开后的思考正文也能收起", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;

		try {
			input.emit("data", Buffer.from("你好\r"));
			agent.emit({ type: "reasoning_delta", text: "line1\nline2\nline3\nline4\nline5\nline6" });
			t.mock.timers.tick(100);

			const headerRow = rowOf("Thinking…");
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			assert.ok(plainLines().join("\n").includes("line1"));

			// 双击正文里的任意一行：整块收起，而不是只能点标题
			const bodyRow = rowOf("line1");
			input.emit("data", Buffer.from(`\x1b[<0;5;${bodyRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${bodyRow}M`));
			assert.equal(plainLines().join("\n").includes("line1"), false);
		} finally {
			exitTui(input);
		}
	});

	it("双击展开后的工具详情也能收起", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;

		try {
			input.emit("data", Buffer.from("读一下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "A-BODY",
				content: "A-BODY",
				details: { startLine: 1, endLine: 1, totalLines: 1 },
			});
			t.mock.timers.tick(100);

			const headRow = rowOf("Read  a.ts");
			assert.ok(headRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headRow}M`));
			assert.ok(plainLines().join("\n").includes("A-BODY"));

			// 双击详情正文：整条工具收起
			const bodyRow = rowOf("A-BODY");
			input.emit("data", Buffer.from(`\x1b[<0;5;${bodyRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${bodyRow}M`));
			assert.equal(plainLines().join("\n").includes("A-BODY"), false);
		} finally {
			exitTui(input);
		}
	});

	it("组头收起后成员的详情也收起", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;
		const doubleClick = (row: number): void => {
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
		};

		try {
			input.emit("data", Buffer.from("看看两个文件\r"));
			for (const [callId, path, body] of [
				["c1", "src/a.ts", "A-BODY"],
				["c2", "src/b.ts", "B-BODY"],
			] as const) {
				agent.emit({ type: "tool_start", callId, name: "read", args: { path } });
				agent.emit({
					type: "tool_end",
					callId,
					name: "read",
					isError: false,
					durationMs: 1,
					summary: body,
					content: body,
					details: { startLine: 1, endLine: 1, totalLines: 1 },
				});
			}
			t.mock.timers.tick(100);

			// 展开组，再展开第一个成员
			doubleClick(rowOf("Read 2 files"));
			doubleClick(rowOf("Read  a.ts"));
			assert.ok(plainLines().join("\n").includes("A-BODY"));

			// 收起组头，再展开：成员的详情不该留着
			doubleClick(rowOf("Read 2 files"));
			doubleClick(rowOf("Read 2 files"));
			assert.equal(plainLines().join("\n").includes("A-BODY"), false);
		} finally {
			exitTui(input);
		}
	});

	it("双击展开的工具组成员，显示该成员的完整参数", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("看看两个文件\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "src/a.ts" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "A-BODY",
				content: "A-BODY",
				details: { startLine: 1, endLine: 1, totalLines: 1 },
			});
			agent.emit({ type: "tool_start", callId: "c2", name: "read", args: { path: "src/b.ts" } });
			t.mock.timers.tick(100);

			// 组头默认收起：先双击组头把成员展开出来
			const headerRow =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("› Read 2 files")) + 1;
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));

			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("› Read  a.ts")) + 1;
			assert.ok(row > 0);

			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("A-BODY"));
			assert.equal(text.includes("path:"), false);
		} finally {
			exitTui(input);
		}
	});

	it("运行中的 Thinking 标题显示耗时", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("你好\r"));
			agent.emit({ type: "reasoning_delta", text: "thinking" });
			t.mock.timers.tick(1500);

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Thinking… 1.0s"));
		} finally {
			exitTui(input);
		}
	});

	it("双击展开长思考时保持标题位置，不跳到底部", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;

		try {
			input.emit("data", Buffer.from("你好\r"));
			const body = Array.from({ length: 20 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`);
			agent.emit({ type: "reasoning_delta", text: body.join("\n") });
			t.mock.timers.tick(100);

			const headerRow = rowOf("Thinking…");
			assert.ok(headerRow > 0);

			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));

			const text = plainLines().join("\n");
			// 展开后标题仍在视口里，并且从头显示正文，而不是跳到最后一行的位置
			assert.ok(text.includes("Thinking…"));
			assert.ok(text.includes("line01"));
		} finally {
			exitTui(input);
		}
	});
});
