import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { plain, styled } from "../../../src/tui/text/line.ts";
import { colorSupport, serializeLine, styleSequence } from "../../../src/tui/screen/style.ts";

describe("styleSequence", () => {
	it("按样式逐项拼出 SGR 参数", () => {
		assert.equal(styleSequence({ bold: true }, true), "\x1b[1m");
		assert.equal(styleSequence({ dim: true, italic: true }, true), "\x1b[2;3m");
		assert.equal(styleSequence({ underline: true, color: "cyan" }, true), "\x1b[4;36m");
		assert.equal(styleSequence({ color: "gray" }, true), "\x1b[90m");
	});

	it("没有样式就没有序列", () => {
		assert.equal(styleSequence(undefined, true), "");
		assert.equal(styleSequence({}, true), "");
	});

	it("关掉颜色后不再输出任何序列", () => {
		assert.equal(styleSequence({ bold: true, color: "red" }, false), "");
	});
});

describe("colorSupport", () => {
	it("默认输出颜色", () => {
		assert.equal(colorSupport({}), true);
	});

	it("NO_COLOR 有值就关闭", () => {
		assert.equal(colorSupport({ NO_COLOR: "1" }), false);
		assert.equal(colorSupport({ NO_COLOR: "" }), true);
	});

	it("TERM=dumb 表示终端不支持控制序列", () => {
		assert.equal(colorSupport({ TERM: "dumb" }), false);
		assert.equal(colorSupport({ TERM: "xterm-256color" }), true);
	});
});

describe("serializeLine", () => {
	it("逐片段写样式并在片段后复位", () => {
		assert.equal(
			serializeLine([{ text: "a" }, { text: "b", style: { bold: true } }, { text: "c" }], true),
			"a\x1b[1mb\x1b[0mc",
		);
	});

	it("关掉颜色时只剩文本", () => {
		assert.equal(serializeLine(styled("接口", { color: "green" }), false), "接口");
		assert.equal(serializeLine(plain("接口"), false), "接口");
	});
});
