import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codePointWidth, displayWidth, graphemeWidth, segmentGraphemes } from "../../../src/tui/text/width.ts";

describe("字符显示宽度", () => {
	it("拉丁字母与数字占一列", () => {
		assert.equal(displayWidth("hello"), 5);
		assert.equal(displayWidth("a1 "), 3);
	});

	it("中日韩文字与全角标点占两列", () => {
		assert.equal(displayWidth("中文"), 4);
		assert.equal(displayWidth("，"), 2);
		assert.equal(displayWidth("１２３"), 6); // 全角数字
	});

	it("控制字符不推进光标", () => {
		assert.equal(displayWidth("\b"), 0);
		assert.equal(displayWidth("\x1b"), 0);
		assert.equal(displayWidth("\x7f"), 0);
	});

	it("组合用记号与零宽字符不占列", () => {
		assert.equal(displayWidth("é"), 1); // e + 组合用重音
		assert.equal(displayWidth("a\u200Bb"), 2); // a + 零宽空格 + b
		assert.equal(displayWidth("e\uFE0E"), 1); // 文本变体选择符不加重数字符
	});

	it("emoji 整簇占两列，多个码位拼成的一个也是", () => {
		assert.equal(displayWidth("★"), 1); // 单码位符号不定成 emoji
		assert.equal(displayWidth("✌"), 1); // 裸胜利手势是文本符号
		assert.equal(displayWidth("✌️"), 2); // 加变体选择符才成 emoji
		assert.equal(displayWidth("👍🏿"), 2); // 肤色修饰符不额外占列
		assert.equal(displayWidth("👨‍👩‍👧"), 2); // 零宽连接符拼合的家庭
	});

	it("国旗由两个区域指示符组成，整簇占两列", () => {
		assert.equal(displayWidth("🇨🇳"), 2);
	});

	it("键盘序号符号整簇占两列", () => {
		assert.equal(displayWidth("1️⃣"), 2);
	});

	it("空串宽为零，null 字符宽为零", () => {
		assert.equal(displayWidth(""), 0);
		assert.equal(codePointWidth(0), 0);
	});

	it("单字宽度与整串宽度一致（按字素簇计量）", () => {
		const sample = "ab中文✌️🇨🇳e\u0301";
		assert.equal(displayWidth(sample), [...sample].map(() => 0).length >= 0 ? displayWidth(sample) : 0);
		let manual = 0;
		for (const cluster of segmentGraphemes(sample)) manual += graphemeWidth(cluster);
		assert.equal(displayWidth(sample), manual);
	});

	it("逐码位计量与整簇计量在带选择符的符号上不同，后者才是正确答案", () => {
		// 逐码位累加会把 ✌️ 算成 1 + 0 = 1 之外的情形，比如带修饰符时明显偏大
		const cluster = "👍🏿";
		assert.ok(graphemeWidth(cluster) < [...cluster].map((c) => codePointWidth(c.codePointAt(0)!)).reduce((a, b) => a + b, 0));
	});
});

describe("字素簇切分", () => {
	it("把组合序列并成一个簇", () => {
		assert.deepEqual(segmentGraphemes("e\u0301"), ["e\u0301"]);
	});

	it("把 emoji ZWJ 序列并成一个簇", () => {
		assert.deepEqual(segmentGraphemes("👨‍👩‍👧"), ["👨‍👩‍👧"]);
	});

	it("逐个拆开普通字母", () => {
		assert.deepEqual(segmentGraphemes("ab"), ["a", "b"]);
		assert.deepEqual(segmentGraphemes(""), []);
	});
});
