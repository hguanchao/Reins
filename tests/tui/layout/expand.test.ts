import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, exitTui, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";

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

	it("连续命令在运行期成组，回合结束后收起", async (t) => {
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

			// 运行期组头已经出现并展开；结果仍收在成员行里
			let text = frameLines(output).map(plain).join("\n");
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
