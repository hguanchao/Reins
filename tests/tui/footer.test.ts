import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputView, renderFooter } from "../../src/tui/footer.ts";

const BORDER = "─";

describe("页脚输入框", () => {
	it("上下边框铺满屏幕宽度，输入行带缩进和提示符", () => {
		const lines = renderFooter(10, "");

		assert.equal(lines.length, 3);
		assert.equal(lines[0], BORDER.repeat(10));
		assert.equal(lines[1], " › ");
		assert.equal(lines[2], BORDER.repeat(10));
	});

	it("输入文字排在提示符之后", () => {
		const lines = renderFooter(10, "abc");
		assert.equal(lines[1], " › abc");
	});

	it("输入超出宽度时保留尾部", () => {
		const lines = renderFooter(5, "abcdef");
		assert.equal(lines[1], " › f");
	});

	it("宽字符按两列计算，不留下半个字", () => {
		const lines = renderFooter(6, "你好世界");
		assert.equal(lines[1], " › 界");
	});

	it("光标列跟着提示符和可见文字走", () => {
		assert.equal(inputView("", 10).text, " › ");
		assert.equal(inputView("", 10).column, 4);
		assert.equal(inputView("abc", 10).column, 7);
		assert.equal(inputView("你好", 10).column, 8);
		assert.equal(inputView("abcdef", 5).column, 5);
		assert.equal(inputView("你好世界", 6).column, 6);
	});
});
