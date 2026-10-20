import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { decodeTextFile, looksBinary } from "../../../src/tools/builtin/text-file.ts";

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
});
