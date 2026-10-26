import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { decodeTextFile, encodeTextFile, looksBinary } from "../../src/tools/text-file.ts";

const PROBE = 8192;

function utf16le(text: string): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function utf16be(text: string): Buffer {
	const body = Buffer.from(text, "utf16le");
	body.swap16();
	return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

describe("文本文件解码", () => {
	it("带 BOM 的 UTF-16 文件不是二进制", () => {
		assert.equal(looksBinary(utf16le("hello"), PROBE), false);
		assert.equal(looksBinary(utf16be("hello"), PROBE), false);
		assert.equal(decodeTextFile(utf16le("hello")).text, "hello");
		assert.equal(decodeTextFile(utf16be("hello")).text, "hello");
	});

	it("没有 BOM 的零字节内容仍按二进制处理", () => {
		assert.equal(looksBinary(Buffer.from([0x00, 0x01, 0x02]), PROBE), true);
	});

	it("UTF-8 BOM 被去掉，编码保持不变", () => {
		const file = decodeTextFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));
		assert.equal(file.text, "hi");
		assert.equal(file.encoding, "utf8");
		assert.equal(file.hasBom, true);
	});

	it("非 UTF-8 文本标记为有损，调用方据此拒绝写回", () => {
		// GBK 的「你好」：解码成 UTF-8 会得到替换字符，整份写回会把原字节永久改坏
		const gbk = Buffer.from([0x61, 0xc4, 0xe3, 0xba, 0xc3, 0x62]);
		const file = decodeTextFile(gbk);
		assert.equal(file.lossy, true);
		assert.equal(file.encoding, "utf8");
	});

	it("合法 UTF-8 不标记为有损", () => {
		const file = decodeTextFile(Buffer.from("你好，世界", "utf8"));
		assert.equal(file.lossy, false);
		assert.equal(file.text, "你好，世界");
	});

	it("UTF-16 文件不标记为有损", () => {
		assert.equal(decodeTextFile(utf16le("hello")).lossy, false);
	});
});

describe("文本文件编码", () => {
	it("CRLF 文件的 newText 自带 CRLF 时不会写出 \\r\\r\\n", () => {
		const original = decodeTextFile(Buffer.from("a\r\nb\r\n", "utf8"));
		assert.equal(original.eol, "\r\n");
		// 模型从命令输出或另一个 Windows 文件里抄来的片段常自带 CRLF
		const encoded = encodeTextFile(original, "a\r\nx\r\ny\r\nb\r\n").toString("utf8");
		assert.doesNotMatch(encoded, /\r\r\n/);
		assert.match(encoded, /x\r\ny/);
	});

	it("UTF-8 BOM 文件写回时保留 BOM", () => {
		const original = decodeTextFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));
		const encoded = encodeTextFile(original, "bye");
		assert.deepEqual([...encoded.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
		assert.equal(encoded.subarray(3).toString("utf8"), "bye");
	});

	it("UTF-16LE 文件写回后仍是 UTF-16LE", () => {
		const original = decodeTextFile(utf16le("hi"));
		const encoded = encodeTextFile(original, "bye");
		assert.equal(encoded.toString("utf16le", 2), "bye");
	});
});
