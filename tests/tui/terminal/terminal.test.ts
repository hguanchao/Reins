import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { ProcessTerminal } from "../../../src/tui/terminal/terminal.ts";

interface FakeInput extends PassThrough {
	rawModes: boolean[];
	setRawMode(value: boolean): void;
}

interface FakeOutput extends PassThrough {
	columns?: number;
	rows?: number;
}

function createInput(): FakeInput {
	const input = new PassThrough() as FakeInput;
	input.rawModes = [];
	input.setRawMode = (value: boolean): void => {
		input.rawModes.push(value);
	};
	return input;
}

function createTerminal(size?: { columns?: number; rows?: number }): {
	terminal: ProcessTerminal;
	input: FakeInput;
	output: FakeOutput;
	text: () => string;
} {
	const input = createInput();
	const output = new PassThrough() as FakeOutput;
	if (size?.columns !== undefined) output.columns = size.columns;
	if (size?.rows !== undefined) output.rows = size.rows;
	const chunks: string[] = [];
	output.on("data", (chunk) => chunks.push(String(chunk)));
	return {
		terminal: new ProcessTerminal(input, output),
		input,
		output,
		text: () => chunks.join(""),
	};
}

describe("ProcessTerminal", () => {
	it("尺寸取自输出流", () => {
		const { terminal } = createTerminal({ columns: 100, rows: 40 });
		assert.deepEqual(terminal.size(), { rows: 40, cols: 100 });
	});

	it("拿不到尺寸时退回一个固定值", () => {
		const { terminal } = createTerminal();
		assert.deepEqual(terminal.size(), { rows: 24, cols: 80 });
	});

	it("尺寸为 0 时也按拿不到处理", () => {
		const { terminal } = createTerminal({ columns: 0, rows: 0 });
		assert.deepEqual(terminal.size(), { rows: 24, cols: 80 });
	});

	it("输入按 UTF-8 解码，多字节字符被切开也能拼回", () => {
		const { terminal, input } = createTerminal();
		const received: string[] = [];
		terminal.onInput((chunk) => received.push(chunk));

		input.write(Buffer.from([0xe4, 0xb8])); // 「中」的前两个字节
		input.write(Buffer.from([0xad]));

		assert.deepEqual(received, ["中"]);
	});

	it("尺寸变化会通知订阅者", () => {
		const { terminal, output } = createTerminal({ columns: 80, rows: 24 });
		let calls = 0;
		terminal.onResize(() => {
			calls += 1;
		});

		output.emit("resize");
		assert.equal(calls, 1);
	});

	it("原始模式转交给输入流", () => {
		const { terminal, input } = createTerminal();
		terminal.setRawMode(true);
		terminal.setRawMode(false);
		assert.deepEqual(input.rawModes, [true, false]);
	});

	it("输入流不支持原始模式时明确报错", () => {
		const terminal = new ProcessTerminal(new PassThrough(), new PassThrough());
		assert.throws(() => terminal.setRawMode(true), /不是终端/);
	});

	it("光标、括号粘贴与焦点上报各自发出对应的序列", () => {
		const { terminal, text } = createTerminal();
		terminal.setCursorVisible(false);
		terminal.setCursorVisible(true);
		terminal.setBracketedPaste(true);
		terminal.setBracketedPaste(false);
		terminal.setFocusReporting(true);
		terminal.setFocusReporting(false);
		assert.equal(text(), "\x1b[?25l\x1b[?25h\x1b[?2004h\x1b[?2004l\x1b[?1004h\x1b[?1004l");
	});
});
