import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	limitLineBytes,
	MAX_LINE_LENGTH,
	splitLines,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../../src/tools/truncate.ts";

describe("工具输出截断", () => {
	it("splitLines:末尾换行不产生空行", () => {
		assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
		assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
		assert.deepEqual(splitLines(""), []);
	});

	it("truncateHead:行数上限", () => {
		const result = truncateHead("1\n2\n3", { maxLines: 2, maxBytes: 1000 });
		assert.equal(result.text, "1\n2");
		assert.equal(result.truncated, true);
		assert.deepEqual({ startLine: result.startLine, endLine: result.endLine, totalLines: result.totalLines }, {
			startLine: 1,
			endLine: 2,
			totalLines: 3,
		});
	});

	it("truncateHead:字节上限", () => {
		const result = truncateHead("aaa\nbbb", { maxLines: 10, maxBytes: 5 });
		assert.equal(result.text, "aaa"); // "aaa\n" 4 字节，再放 "bbb" 就超 5
		assert.equal(result.truncated, true);
	});

	it("truncateHead:第一行就超字节上限时保留半行", () => {
		const long = "x".repeat(100);
		const result = truncateHead(long, { maxLines: 10, maxBytes: 10 });
		assert.equal(result.text.length, 10);
		assert.equal(result.truncated, true);
	});

	it("truncateHead:不超限时原样返回", () => {
		const result = truncateHead("a", { maxLines: 10, maxBytes: 100 });
		assert.equal(result.text, "a");
		assert.equal(result.truncated, false);
	});

	it("truncateTail:结论在最后时从结尾保留", () => {
		const result = truncateTail("early\nearly\nconclusion", { maxLines: 1, maxBytes: 1000 });
		assert.equal(result.text, "conclusion");
		assert.equal(result.truncated, true);
		assert.equal(result.startLine, 3); // 保留区间的首行(1 起)
		assert.equal(result.endLine, 3);
	});

	it("truncateTail:字节数从尾部往回收", () => {
		const lines = ["a", "b", "very-long-line", "c"];
		const result = truncateTail(lines.join("\n"), { maxLines: 10, maxBytes: 4 });
		// 从尾部往回： "c" 2 字节、 "very-long-line" 太长被丢後继续回收到 "b"
		assert.ok(!result.text.includes("very-long-line"));
	});

	it("limitLineBytes 不把多字节字符切成半个", () => {
		const line = "中中中中"; // 每字 3 字节,共 12 字节
		const limited = limitLineBytes(line, 6);
		assert.equal(Buffer.byteLength(limited, "utf8"), 6);
		assert.equal(limited, "中中");
	});

	it("truncateLine:超长行加省略号和说明", () => {
		const long = "x".repeat(MAX_LINE_LENGTH + 1);
		const truncated = truncateLine(long);
		assert.ok(truncated.endsWith(`(the line is ${long.length} characters long)`));
		assert.equal(truncateLine("short"), "short");
	});
});
