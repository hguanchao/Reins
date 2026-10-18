import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderFooter } from "../../src/tui/footer.ts";

const CURSOR = "\x1b[7m \x1b[0m";
const BORDER = "─";

describe("页脚输入框", () => {
	it("上下边框铺满屏幕宽度，输入行末尾是光标", () => {
		const lines = renderFooter(10, "", false);

		assert.equal(lines.length, 3);
		assert.equal(lines[0], BORDER.repeat(10));
		assert.equal(lines[1], CURSOR);
		assert.equal(lines[2], BORDER.repeat(10));
	});

	it("输入文字排在光标之前", () => {
		const lines = renderFooter(10, "abc", false);
		assert.equal(lines[1], `abc${CURSOR}`);
	});

	it("输入超出宽度时保留尾部，光标始终可见", () => {
		const lines = renderFooter(5, "abcdef", false);
		assert.equal(lines[1], `cdef${CURSOR}`);
	});

	it("宽字符按两列计算，不留下半个字", () => {
		const lines = renderFooter(6, "你好世界", false);
		assert.equal(lines[1], `世界${CURSOR}`);
	});

	it("第一次按 Ctrl+C 的提示嵌在下边框里", () => {
		const lines = renderFooter(40, "", true);

		assert.equal(lines[0], BORDER.repeat(40));
		assert.equal(lines[1], CURSOR);
		assert.ok(lines[2].includes("Press Ctrl+C again to exit"));
		assert.equal(lines[2].length, 40);
	});
});
