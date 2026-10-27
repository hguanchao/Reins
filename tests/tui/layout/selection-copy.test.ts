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
} from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";

/** 在对话流里找到一段文字，返回它的屏幕行与起止列（1 基）。 */
function locate(
	output: FakeOutput,
	needle: string,
	from: number,
): { readonly row: number; readonly start: number; readonly end: number } {
	const lines = frameLines(output).map(plain);
	const rowIndex = lines.findIndex((line) => line.includes(needle));
	assert.ok(rowIndex >= 0, `找不到 ${needle}`);
	const line = lines[rowIndex] ?? "";
	const begin = line.indexOf(needle, from);
	assert.ok(begin >= 0, `找不到 ${needle} 的列`);
	return { row: rowIndex + 1, start: begin + 1, end: begin + needle.length };
}

describe("鼠标拖选复制", () => {
	it("拖动一段文字，松开后复制到系统剪贴板", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const copied: string[] = [];
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			clipboard: {
				copy: (text) => {
					copied.push(text);
					return true;
				},
			},
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);

			const span = locate(output, "hello world", 0);
			input.emit(
				"data",
				Buffer.from(`\x1b[<0;${span.start};${span.row}M\x1b[<32;${span.end};${span.row}M`),
			);
			t.mock.timers.tick(100);
			// 拖动过程中选区反显
			assert.ok(frameLines(output).some((line) => line.includes("\x1b[7m")));

			input.emit("data", Buffer.from(`\x1b[<0;${span.end};${span.row}m`));
			t.mock.timers.tick(100);

			assert.deepEqual(copied, ["hello world"]);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Copied 11 chars"));
		} finally {
			exitTui(input);
		}
	});

	it("没有系统剪贴板写入时退到 OSC 52", (t) => {
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
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);

			const span = locate(output, "hello world", 0);
			input.emit(
				"data",
				Buffer.from(
					`\x1b[<0;${span.start};${span.row}M` +
						`\x1b[<32;${span.end};${span.row}M` +
						`\x1b[<0;${span.end};${span.row}m`,
				),
			);
			t.mock.timers.tick(100);

			assert.ok(
				output.chunks.some((chunk) =>
					chunk.includes(`\x1b]52;c;${Buffer.from("hello world").toString("base64")}\x07`),
				),
			);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Copy sent to terminal"));
		} finally {
			exitTui(input);
		}
	});

	it("原地点击不复制", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const copied: string[] = [];
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
			clipboard: {
				copy: (text) => {
					copied.push(text);
					return true;
				},
			},
		});

		try {
			input.emit("data", Buffer.from("说点话\r"));
			agent.emit({ type: "text_delta", text: "AA hello world BB" });
			t.mock.timers.tick(100);

			const span = locate(output, "hello world", 0);
			input.emit(
				"data",
				Buffer.from(`\x1b[<0;${span.start};${span.row}M\x1b[<0;${span.start};${span.row}m`),
			);
			t.mock.timers.tick(100);

			assert.deepEqual(copied, []);
		} finally {
			exitTui(input);
		}
	});
});
