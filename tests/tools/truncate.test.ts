import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_LIMITS,
	limitLineBytes,
	splitLines,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../../src/tools/truncate.ts";

describe("按行切分", () => {
	it("以换行结尾时不产生额外的空行", () => {
		assert.deepEqual(splitLines("甲\n乙\n"), ["甲", "乙"]);
		assert.deepEqual(splitLines("甲\n乙"), ["甲", "乙"]);
		assert.deepEqual(splitLines(""), []);
		assert.deepEqual(splitLines("\n"), [""]);
	});
});

describe("从开头截断", () => {
	it("行数够用时不截断", () => {
		const result = truncateHead("甲\n乙\n丙", DEFAULT_LIMITS);
		assert.equal(result.text, "甲\n乙\n丙");
		assert.equal(result.truncated, false);
		assert.equal(result.totalLines, 3);
	});

	it("超出行数上限时只保留前若干行", () => {
		const text = Array.from({ length: 10 }, (_item, index) => `第${index + 1}行`).join("\n");
		const result = truncateHead(text, { maxLines: 3, maxBytes: 1024 });
		assert.equal(result.text, "第1行\n第2行\n第3行");
		assert.equal(result.truncated, true);
		assert.equal(result.endLine, 3);
		assert.equal(result.totalLines, 10);
	});

	it("超出字节上限时按整行截断", () => {
		const result = truncateHead("甲".repeat(10) + "\n乙".repeat(10), { maxLines: 100, maxBytes: 31 });
		// 「甲」每字 3 字节，加换行刚好 31 字节，第二行放不下
		assert.equal(result.text, "甲".repeat(10));
		assert.equal(result.truncated, true);
	});

	it("第一行就超限时保留它的前一段并标记截断", () => {
		const result = truncateHead("甲".repeat(100), { maxLines: 10, maxBytes: 30 });
		assert.equal(result.text, "甲".repeat(10));
		assert.equal(result.truncated, true);
	});
});

describe("从结尾截断", () => {
	it("保留最后的若干行", () => {
		const text = Array.from({ length: 10 }, (_item, index) => `第${index + 1}行`).join("\n");
		const result = truncateTail(text, { maxLines: 3, maxBytes: 1024 });
		assert.equal(result.text, "第8行\n第9行\n第10行");
		assert.equal(result.truncated, true);
		assert.equal(result.startLine, 8);
		assert.equal(result.endLine, 10);
	});
});

describe("单行处理", () => {
	it("超长行只留前一段并注明原长", () => {
		const line = "x".repeat(600);
		const result = truncateLine(line, 500);
		assert.ok(result.startsWith("x".repeat(500)));
		assert.ok(result.includes("共 600 个字符"));
	});

	it("不超长时原样返回", () => {
		assert.equal(truncateLine("短行", 500), "短行");
	});

	it("按字节限制切行时不切开多字节字符", () => {
		const limited = limitLineBytes("甲".repeat(10), 10);
		assert.equal(limited, "甲".repeat(3));
		assert.equal(Buffer.byteLength(limited, "utf8"), 9);
	});
});
