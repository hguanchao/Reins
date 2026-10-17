import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { colorSupport, serializeLine, styleSequence } from "../../../src/tui/screen/style.ts";
import { concat, plain, styled } from "../../../src/tui/text/line.ts";

	describe("样式转序列", () => {
	it("无样式返回空串，colors 关闭时也返回空串", () => {
		assert.equal(styleSequence(undefined, true), "");
		assert.equal(styleSequence({ bold: true }, false), "");
		assert.equal(serializeLine([], true), "");
	});

	it("布尔项按序输出", () => {
		assert.equal(styleSequence({ bold: true, underline: true }, true), "\x1b[1;4m");
		assert.equal(styleSequence({ reverse: true }, true), "\x1b[7m");
	});

	it("十六色前景与背景用同一张表，背景加十", () => {
		assert.equal(styleSequence({ color: "red" }, true), "\x1b[31m");
		assert.equal(styleSequence({ background: "red" }, true), "\x1b[41m");
		assert.equal(styleSequence({ color: "gray" }, true), "\x1b[90m");
	});

	it("真彩色按 38;2 与 48;2 输出", () => {
		assert.equal(styleSequence({ color: [10, 20, 30] }, true), "\x1b[38;2;10;20;30m");
		assert.equal(styleSequence({ background: [1, 2, 3] }, true), "\x1b[48;2;1;2;3m");
	});

	it("混合样式合并成一条序列", () => {
		assert.equal(styleSequence({ dim: true, color: "blue" }, true), "\x1b[2;34m");
	});

	it("serializeLine 每个带样式的片段之后复位", () => {
		const line = concat(plain("a"), styled("b", { bold: true }), plain("c"));
		assert.equal(serializeLine(line, true), "a\x1b[1mb\x1b[0mc");
	});

	it("colors 关闭时只输出纯文本", () => {
		const line = concat(plain("a"), styled("b", { bold: true }));
		assert.equal(serializeLine(line, false), "ab");
	});
});

describe("颜色开关", () => {
	it("NO_COLOR 有值即关闭，空串不算有值", () => {
		assert.equal(colorSupport({ NO_COLOR: "1" }), false);
		assert.equal(colorSupport({ NO_COLOR: "" }), true);
	});

	it("TERM=dumb 关闭", () => {
		assert.equal(colorSupport({ TERM: "dumb" }), false);
	});

	it("其余情况都开", () => {
		assert.equal(colorSupport({}), true);
		assert.equal(colorSupport({ TERM: "xterm-256color" }), true);
		assert.equal(colorSupport({ NO_COLOR: "", TERM: "xterm" }), true);
	});
});
