import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../../src/config/config-error.ts";
import { JsonDocument } from "../../../src/config/json/document.ts";

function parse(source: string): JsonDocument {
	return new JsonDocument(source);
}

function expectError(source: string, messagePart: string, line?: number): ConfigError {
	try {
		parse(source);
	} catch (error) {
		assert.ok(error instanceof ConfigError, `期望 ConfigError，实际是 ${String(error)}`);
		assert.ok(
			error.message.includes(messagePart),
			`期望错误信息包含「${messagePart}」，实际是「${error.message}」`,
		);
		if (line !== undefined) assert.equal(error.line, line);
		return error;
	}
	throw new Error("期望解析失败，但解析成功了");
}

describe("JsonParser 解析", () => {
	it("解析对象、数组与各类标量", () => {
		const document = parse('{ "a": 1, "b": "x", "c": true, "d": null, "e": [1, 2], "f": {} }');
		assert.equal(document.get(["a"]), 1);
		assert.equal(document.get(["b"]), "x");
		assert.equal(document.get(["c"]), true);
		assert.equal(document.get(["d"]), null);
		assert.deepEqual(document.get(["e"]), [1, 2]);
		assert.deepEqual(document.get(["f"]), {});
	});

	it("解析负数与浮点的各种写法", () => {
		const document = parse('{ "a": -1, "b": 2.5, "c": 1e3, "d": -2.5e-2, "e": 0 }');
		assert.equal(document.get(["a"]), -1);
		assert.equal(document.get(["b"]), 2.5);
		assert.equal(document.get(["c"]), 1000);
		assert.equal(document.get(["d"]), -0.025);
		assert.equal(document.get(["e"]), 0);
	});

	it("处理字符串转义", () => {
		const document = parse('{ "a": "\\"\\\\\\/\\b\\f\\n\\r\\t", "u": "\\u4E2D" }');
		assert.equal(document.get(["a"]), '"\\/\b\f\n\r\t');
		assert.equal(document.get(["u"]), "中");
	});

	it("允许行注释与块注释", () => {
		const document = parse(`{
			// 行注释
			"a": 1, /* 块注释
			跨行 */
			"b": 2
		}`);
		assert.equal(document.get(["a"]), 1);
		assert.equal(document.get(["b"]), 2);
	});

	it("注释里出现斜杠不会误判", () => {
		const document = parse('{ "a": "http://x/y", // http://z\n "b": 2 }');
		assert.equal(document.get(["a"]), "http://x/y");
		assert.equal(document.get(["b"]), 2);
	});

	it("按键路径取值，路径类型不符时返回 undefined", () => {
		const document = parse('{ "a": { "b": [ { "c": 1 } ] } }');
		assert.equal(document.get(["a", "b", 0, "c"]), 1);
		assert.equal(document.get(["a", "b", 1, "c"]), undefined);
		assert.equal(document.get(["a", 0]), undefined);
		assert.equal(document.get(["missing"]), undefined);
	});

	it("记录键与数组元素的位置", () => {
		const document = parse('{\n  "a": {\n    "b": 1\n  },\n  "list": [\n    1\n  ]\n}');
		assert.deepEqual(document.locationOf(["a"]), { line: 2, column: 3 });
		assert.deepEqual(document.locationOf(["a", "b"]), { line: 3, column: 5 });
		assert.deepEqual(document.locationOf(["list", 0]), { line: 6, column: 5 });
		assert.equal(document.locationOf(["missing"]), undefined);
	});
});

describe("JsonParser 拒绝非法输入", () => {
	it("拒绝重复的键", () => {
		expectError('{ "a": 1, "a": 2 }', "重复定义", 1);
	});

	it("拒绝未加引号的键", () => {
		expectError("{ a: 1 }", "键必须是双引号字符串");
	});

	it("拒绝单引号字符串", () => {
		expectError("{ 'a': 1 }", "键必须是双引号字符串");
	});

	it("拒绝缺少冒号", () => {
		expectError('{ "a" 1 }', "需要冒号");
	});

	it("拒绝未闭合的字符串", () => {
		expectError('{ "a": "x', "没有闭合");
	});

	it("拒绝不支持的转义", () => {
		expectError('{ "a": "\\q" }', "不支持的转义");
	});

	it("拒绝字符串里的裸控制字符", () => {
		expectError('{ "a": "x\ny" }', "控制字符");
	});

	it("拒绝前导零与十六进制数字", () => {
		expectError('{ "a": 01 }', "无法识别的值");
		expectError('{ "a": 0x1 }', "无法识别的值");
	});

	it("拒绝尾随逗号", () => {
		expectError('{ "a": 1, }', "多余的逗号");
		expectError('{ "a": [1, ] }', "多余的逗号");
	});

	it("拒绝未闭合的块注释", () => {
		expectError('{ "a": 1 } /* 没有闭合', "块注释没有闭合");
	});

	it("拒绝空文件与多余内容", () => {
		expectError("", "文件为空");
		expectError('{ "a": 1 } {}', "还有多余内容");
	});
});
