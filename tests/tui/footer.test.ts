import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FOOTER_HEIGHT, inputView, renderFooter } from "../../src/tui/footer.ts";

const BORDER = "─";
const FOCUS = "\x1b[38;2;204;204;204m";
const BLUR = "\x1b[38;2;46;46;46m";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("页脚输入框", () => {
	it("获得焦点时边框和提示符用 #cccccc", () => {
		const lines = renderFooter(10, "", true);

		assert.equal(lines.length, FOOTER_HEIGHT);
		assert.equal(lines[0], "");
		assert.ok(lines[1].startsWith(FOCUS));
		assert.equal(plain(lines[1]), BORDER.repeat(10));
		assert.ok(lines[2].startsWith(FOCUS));
		assert.equal(plain(lines[2]), " › ");
		assert.ok(lines[3].startsWith(FOCUS));
		assert.equal(plain(lines[3]), BORDER.repeat(10));
	});

	it("失去焦点时边框和提示符用 #2e2e2e", () => {
		const lines = renderFooter(10, "", false);

		assert.equal(lines[0], "");
		assert.ok(lines[1].startsWith(BLUR));
		assert.ok(lines[2].startsWith(BLUR));
		assert.equal(plain(lines[1]), BORDER.repeat(10));
		assert.equal(plain(lines[2]), " › ");
		assert.equal(plain(lines[3]), BORDER.repeat(10));
	});

	it("输入文字排在提示符之后，不受焦点颜色影响", () => {
		const lines = renderFooter(10, "abc", true);

		assert.equal(plain(lines[2]), " › abc");
		assert.ok(lines[2].startsWith(FOCUS));
		assert.ok(lines[2].endsWith("abc"));
	});

	it("输入超出宽度时保留尾部", () => {
		const lines = renderFooter(5, "abcdef", true);
		assert.equal(plain(lines[2]), " › f");
	});

	it("宽字符按两列计算，不留下半个字", () => {
		const lines = renderFooter(6, "你好世界", true);
		assert.equal(plain(lines[2]), " › 界");
	});

	it("有运行时状态时显示加载符号与文字", () => {
		const lines = renderFooter(40, "", true, { symbol: "⠋", text: "Waiting for response..." });

		assert.equal(lines[0], " ⠋ Waiting for response...");
		assert.equal(lines[0]?.length, 26);
		assert.equal(plain(lines[2]), " › ");
	});

	it("状态行显示计时与 token 数", () => {
		const lines = renderFooter(60, "", true, {
			symbol: "⠋",
			text: "Thinking...",
			elapsedMs: 1200,
			tokens: 128,
		});

		assert.equal(lines[0], " ⠋ Thinking...  1.2s  128 tokens");
	});

	it("状态行超出宽度时截断", () => {
		const lines = renderFooter(10, "", true, { symbol: "⠋", text: "Waiting for response..." });
		assert.equal(lines[0], " ⠋ Waiting");
	});

	it("运行时状态可以带扫光", () => {
		const lines = renderFooter(40, "", true, {
			symbol: "⠋",
			text: "Waiting for response...",
			sweep: 0.5,
		});

		assert.equal(plain(lines[0] ?? ""), " ⠋ Waiting for response...");
		assert.ok(lines[0]?.includes("\x1b[38;2;255;255;255m"));
		assert.ok(lines[0]?.endsWith("\x1b[0m"));
	});

	it("光标列跟着提示符和可见文字走", () => {
		const empty = inputView("", 10);
		assert.equal(empty.prefix, " › ");
		assert.equal(empty.text, "");
		assert.equal(empty.column, 4);

		const ascii = inputView("abc", 10);
		assert.equal(ascii.prefix, " › ");
		assert.equal(ascii.text, "abc");
		assert.equal(ascii.column, 7);

		assert.equal(inputView("你好", 10).column, 8);
		assert.equal(inputView("abcdef", 5).column, 5);
		assert.equal(inputView("abcdef", 5).text, "f");
		assert.equal(inputView("你好世界", 6).column, 6);
		assert.equal(inputView("你好世界", 6).text, "界");
	});
});
