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
		assert.equal(styleSequence({ strikethrough: true }, true), "\x1b[9m");
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

	it("安全链接用 OSC 8 包住文本，危险协议不输出", () => {
		assert.equal(
			serializeLine(styled("docs", { link: "https://example.com" }), true),
			"\x1b]8;;https://example.com\x07docs\x1b]8;;\x07",
		);
		assert.equal(
			serializeLine(styled("mail", { link: "mailto:a@b.c" }), true),
			"\x1b]8;;mailto:a@b.c\x07mail\x1b]8;;\x07",
		);
		assert.equal(serializeLine(styled("bad", { link: "javascript:alert(1)" }), true), "bad");
		assert.equal(serializeLine(styled("bad", { link: "https://a\nb" }), true), "bad");
		assert.equal(serializeLine(styled("plain", { link: "https://example.com" }), false), "plain");
	});

	it("混合样式合并成一条序列", () => {
		assert.equal(styleSequence({ dim: true, color: "blue" }, true), "\x1b[2;34m");
	});

	it("serializeLine 每个带样式的片段之后复位", () => {
		const line = concat(plain("a"), styled("b", { bold: true }), plain("c"));
		assert.equal(serializeLine(line, true), "a\x1b[1mb\x1b[0mc");
	});

	it("相邻片段样式相同时不重复发序列，行尾只复位一次", () => {
		const line = concat(styled("a", { bold: true }), styled("b", { bold: true }), plain("c"), styled("d", { bold: true }));
		assert.equal(serializeLine(line, true), "\x1b[1mab\x1b[0mc\x1b[1md\x1b[0m");
	});

	it("后一样式包含前一样式时直接叠加，中间不插复位", () => {
		const line = concat(styled("a", { bold: true }), styled("b", { bold: true, color: "red" }));
		assert.equal(serializeLine(line, true), "\x1b[1ma\x1b[1;31mb\x1b[0m");
	});

	it("只有链接不同的相邻片段不重发样式", () => {
		const line = concat(
			styled("a", { bold: true, link: "https://a.example" }),
			styled("b", { bold: true, link: "https://a.example" }),
		);
		assert.equal(serializeLine(line, true), "\x1b[1m\x1b]8;;https://a.example\x07ab\x1b]8;;\x07\x1b[0m");
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
