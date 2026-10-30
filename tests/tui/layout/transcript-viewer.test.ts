import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FakeInput,
	FakeOutput,
	createFakeAgent,
	FOOTER_INFO,
	exitTui,
	frameLines,
	plain,
} from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";

describe("对话流长内容查看", () => {
	it("Ctrl+G 打开最近工具输出的整屏页，Esc 返回", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});
		const body = Array.from(
			{ length: 40 },
			(_, index) => `output-${String(index + 1).padStart(2, "0")}`,
		).join("\n");

		try {
			input.emit("data", Buffer.from("跑一下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "run" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "",
				content: body,
			});
			t.mock.timers.tick(100);

			// 对话流本身保持现状；Ctrl+G 才进入完整查看
			input.emit("data", Buffer.from("\x07"));
			t.mock.timers.tick(100);
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins · Bash output"));
			assert.ok(text.includes("output-01"));
			assert.ok(text.includes("↑/↓"));

			// 超出首屏的尾部也能滚到
			input.emit("data", Buffer.from("\x1b[1;5F"));
			t.mock.timers.tick(100);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("output-40"));

			// Esc 回到对话流与输入框
			input.emit("data", Buffer.from("\x1b"));
			t.mock.timers.tick(100);
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Reins · Bash output"), false);
			assert.ok(text.includes("📁 Reins"));
		} finally {
			exitTui(input);
		}
	});

	it("Ctrl+G 查看点选过的工具，而不是最新工具", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("跑两下\r"));
			agent.emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "first" } });
			agent.emit({
				type: "tool_end",
				callId: "c1",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "FIRST-OUTPUT",
				content: "FIRST-OUTPUT",
			});
			agent.emit({ type: "tool_start", callId: "c2", name: "bash", args: { command: "second" } });
			agent.emit({
				type: "tool_end",
				callId: "c2",
				name: "bash",
				isError: false,
				durationMs: 1,
				summary: "SECOND-OUTPUT",
				content: "SECOND-OUTPUT",
			});
			t.mock.timers.tick(100);

			// 组默认收起：先双击组头展开，才能点选到具体成员
			const headerRow =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("› Ran 2 commands")) + 1;
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));

			// 点选较早的那条工具行；Ctrl+G 应该跟着它，而不是回到最新一条
			const row = frameLines(output).map(plain).findIndex((line) => line.includes("first")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));

			input.emit("data", Buffer.from("\x07"));
			t.mock.timers.tick(100);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins · Bash output"));
			assert.ok(text.includes("FIRST-OUTPUT"));
			assert.equal(text.includes("SECOND-OUTPUT"), false);
		} finally {
			exitTui(input);
		}
	});

	it("没有工具输出时 Ctrl+G 查看最近的长提示", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});
		const prompt = ["第一行", "第二行", "第三行", "第四行", "第五行", "第六行"].join("\n");

		try {
			input.emit("data", Buffer.from(`\x1b[200~${prompt}\x1b[201~`));
			input.emit("data", Buffer.from("\r"));
			t.mock.timers.tick(100);

			// 对话流里的提示块仍然是三行；整屏页能看到后面几行
			input.emit("data", Buffer.from("\x07"));
			t.mock.timers.tick(100);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins · Prompt"));
			assert.ok(text.includes("第六行"));
		} finally {
			exitTui(input);
		}
	});

	it("没有可查看内容时只给提示", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("\x07"));
			t.mock.timers.tick(100);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Nothing to view yet"));
			// 提示是静止状态：不该带着属于活动回合的 0.0s 与用量
			assert.equal(text.includes("0.0s"), false);
			assert.equal(text.includes("⇣0"), false);
			assert.ok(text.includes("📁 Reins"));
		} finally {
			exitTui(input);
		}
	});
});
