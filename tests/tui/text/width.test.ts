import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codePointWidth, displayWidth } from "../../../src/tui/text/width.ts";

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
