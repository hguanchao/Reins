import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputView, renderFooter } from "../../src/tui/footer.ts";

const BORDER = "─";

describe("页脚输入框", () => {
	it("上下边框铺满屏幕宽度，输入行默认为空", () => {
		const lines = renderFooter(10, "", false);

		assert.equal(lines.length, 3);
		assert.equal(lines[0], BORDER.repeat(10));
		assert.equal(lines[1], "");
		assert.equal(lines[2], BORDER.repeat(10));
	});

	it("输入文字原样显示", () => {
		const lines = renderFooter(10, "abc", false);
		assert.equal(lines[1], "abc");
	});

	it("输入超出宽度时保留尾部", () => {
		const lines = renderFooter(5, "abcdef", false);
		assert.equal(lines[1], "cdef");
	});

	it("宽字符按两列计算，不留下半个字", () => {
		const lines = renderFooter(6, "你好世界", false);
		assert.equal(lines[1], "世界");
	});

	it("光标列跟着可见文字走", () => {
		assert.equal(inputView("", 10).column, 1);
		assert.equal(inputView("abc", 10).column, 4);
		assert.equal(inputView("你好", 10).column, 5);
		assert.equal(inputView("abcdef", 5).column, 5);
		assert.equal(inputView("你好世界", 6).column, 5);
	});

	it("第一次按 Ctrl+C 的提示嵌在下边框里", () => {
		const lines = renderFooter(40, "", true);

		assert.equal(lines[0], BORDER.repeat(40));
		assert.equal(lines[1], "");
		assert.ok(lines[2].includes("Press Ctrl+C again to exit"));
		assert.equal(lines[2].length, 40);
	});
});
