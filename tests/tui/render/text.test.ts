import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	characterWidth,
	displayWidth,
	sanitizeForDisplay,
	truncateToWidth,
	wrapText,
	wrapWords,
	wrappedLines,
} from "../../../src/tui/render/text.ts";

describe("显示宽度", () => {
	it("中文与 emoji 占两列", () => {
		assert.equal(characterWidth("中"), 2);
		assert.equal(displayWidth("ab中"), 4);
	});

	it("组合字符不占列，emoji 簇整体两列", () => {
		assert.equal(displayWidth("e\u0301"), 1);
		assert.equal(displayWidth("👍🏽"), 2);
		assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2);
		assert.equal(displayWidth("🇨🇳"), 2);
		assert.equal(displayWidth("❤️"), 2);
		assert.equal(displayWidth("1️⃣"), 2);
	});

	it("截断与折行不拆开字素簇", () => {
		assert.equal(truncateToWidth("a👨‍👩‍👧‍👦b", 2), "a");
		assert.deepEqual(wrapText("a👨‍👩‍👧‍👦b", 2), ["a", "👨‍👩‍👧‍👦", "b"]);
		assert.equal(truncateToWidth("👍🏽x", 2), "👍🏽");
	});
});

describe("文本净化", () => {
	it("清掉 ANSI 转义序列", () => {
		assert.equal(sanitizeForDisplay("\x1b[2Jhello\x1b[1;1H"), "hello");
	});

	it("清掉 OSC 序列（例如写剪贴板）", () => {
		assert.equal(sanitizeForDisplay("a\x1b]52;c;ZXZpbA==\x07b"), "ab");
	});

	it("保留换行，制表展开成空格，CR 不会回写整行", () => {
		assert.equal(sanitizeForDisplay("a\nb\tc"), "a\nb    c");
		assert.equal(sanitizeForDisplay("a\r\nb"), "a\nb");
		assert.equal(sanitizeForDisplay("a\rb"), "a b");
	});
});

describe("折行", () => {
	it("换行符是硬断行，不会被当成宽度 1 的字符", () => {
		assert.deepEqual(wrapText("first\nsecond", 20), ["first", "second"]);
	});

	it("多行内容按行分别折行", () => {
		assert.deepEqual(wrapText("abcdef\nxy", 3), ["abc", "def", "xy"]);
	});

	it("按词折行时同样尊重换行", () => {
		assert.deepEqual(wrapWords("one two\nthree", 20), ["one two", "three"]);
	});

	it("折行结果不含转义序列", () => {
		const lines = wrapText("safe\x1b[2Jtext", 40);
		assert.equal(lines.join(""), "safetext");
	});

	it("wrappedLines 折行并悬挂缩进", () => {
		const lines = wrappedLines("a\nb", "› ", 10, "");
		assert.equal(lines.length, 2);
		assert.ok(lines[0]?.includes("› a"));
		assert.ok(lines[1]?.includes("  b"));
	});
});

describe("截断", () => {
	it("截断不把宽字符切成半个", () => {
		assert.equal(truncateToWidth("中文", 3), "中");
	});
});
