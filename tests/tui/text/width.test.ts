import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codePointWidth, displayWidth, graphemeWidth } from "../../../src/tui/text/width.ts";

describe("displayWidth", () => {
	it("拉丁字母与半角标点占一列", () => {
		assert.equal(displayWidth("provider"), 8);
		assert.equal(displayWidth("a = 1"), 5);
		assert.equal(displayWidth(""), 0);
	});

	it("中日韩文字与全角标点占两列", () => {
		assert.equal(displayWidth("思考等级"), 8);
		assert.equal(displayWidth("，。！"), 6);
		assert.equal(displayWidth("コンピュータ"), 12);
		assert.equal(displayWidth("한글"), 4);
	});

	it("表情符号占两列", () => {
		assert.equal(displayWidth("😀"), 2);
	});

	it("组合用记号不额外占列", () => {
		assert.equal(displayWidth("e\u0301"), 1);
		assert.equal(displayWidth("\uFE0F"), 0);
	});

	it("中英混排按各自宽度累加", () => {
		assert.equal(displayWidth("api 接口"), 8);
		assert.equal(displayWidth("baseUrl 地址"), 12);
	});

	it("控制字符不推进光标", () => {
		assert.equal(displayWidth("\t"), 0);
		assert.equal(displayWidth("\u0000"), 0);
		assert.equal(displayWidth("a\tb"), 2);
	});

	it("码位宽度与字符串宽度一致", () => {
		for (const char of "a中，😀") {
			assert.equal(codePointWidth(char.codePointAt(0) ?? 0), displayWidth(char));
		}
	});
});

describe("graphemeWidth", () => {
	it("多个码位组成的 emoji 只占两列", () => {
		assert.equal(graphemeWidth("👨‍👩‍👧"), 2); // 零宽连接符拼接
		assert.equal(graphemeWidth("👍🏽"), 2); // 肤色修饰符
		assert.equal(graphemeWidth("🇨🇳"), 2); // 区域指示符拼成的旗子
		assert.equal(graphemeWidth("1️⃣"), 2); // 带变体选择符的按键符
	});

	it("要求按文字呈现时退回基字符宽度", () => {
		assert.equal(graphemeWidth("☺\uFE0E"), 1);
		assert.equal(graphemeWidth("🀄\uFE0E"), 2);
	});

	it("组合用记号仍不额外占列", () => {
		assert.equal(graphemeWidth("e\u0301"), 1);
		assert.equal(graphemeWidth("漢\u0301"), 2);
	});

	it("没有基字符的簇不按 emoji 算", () => {
		assert.equal(graphemeWidth("\uFE0F"), 0);
		assert.equal(graphemeWidth("\u200D"), 0);
	});

	it("整串宽度等于各簇宽度之和", () => {
		const text = "修 🇨🇳 的 banner 👍🏽";
		const clusters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
			(item) => item.segment,
		);
		const summed = clusters.reduce((total, cluster) => total + graphemeWidth(cluster), 0);
		assert.equal(displayWidth(text), summed);
	});
});
