import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jsonPathKey, JsonParser, type JsonObject } from "../../../src/config/json/parser.ts";
import type { LineColumn } from "../../../src/config/error.ts";
import { ConfigError } from "../../../src/config/error.ts";
function parse(source: string): { value: unknown; locations: Map<string, LineColumn> } {
	try {
		return new JsonParser(source).parse() as { value: unknown; locations: Map<string, LineColumn> };
	} catch (error) {
		if (error instanceof ConfigError) throw new Error(error.display);
		throw error;
	}
}

function expectError(source: string, expected: string): void {
	assert.throws(() => parse(source), (error: unknown) => error instanceof Error && error.message.includes(expected));
}

describe("JSON 解析", () => {
	it("解析普通对象与数组", () => {
		const { value } = parse(`{"a": 1, "b": ["x", true, null], "c": {"d": false}}`);
		assert.deepEqual(value, { a: 1, b: ["x", true, null], c: { d: false } });
	});

	it("支持行注释与块注释", () => {
		const { value } = parse(`{
			// 行注释
			"a": 1, /* 块注释
			跨行 */
			"b": 2
		}`);
		assert.deepEqual(value, { a: 1, b: 2 });
	});

	it("字符串转义", () => {
		const { value } = parse(`{"s": "a\\"b\\\\c\\u0041\\t"}`);
		assert.deepEqual((value as JsonObject)["s"], 'a"b\\cA\t');
	});

	it("数字：整数、小数、指数", () => {
		const { value } = parse(`{"i": -12, "f": 1.5, "e": 2e3, "z": 0}`);
		assert.deepEqual(value, { i: -12, f: 1.5, e: 2000, z: 0 });
	});

	it("记录每个键的位置", () => {
		const { locations } = parse(`{
  "alpha": 1,
  "beta": [10, 20]
}`);
		const alpha = locations.get(jsonPathKey(["alpha"]));
		assert.ok(alpha);
		assert.equal(alpha.line, 2);
		const betaItem = locations.get(jsonPathKey(["beta", 1]));
		assert.ok(betaItem);
		assert.equal(betaItem.line, 3);
	});

	it("重复键报错并指明键名", () => {
		expectError(`{"a": 1, "a": 2}`, "Duplicate key a");
	});

	it("尾随逗号报错", () => {
		expectError(`{"a": 1,}`, "trailing comma");
		expectError(`[1, 2,]`, "trailing comma");
	});

	it("缺逗号报错", () => {
		expectError(`{"a": 1 "b": 2}`, "separated by commas");
	});

	it("键必须双引号", () => {
		expectError(`{a: 1}`, "Unrecognized value a");
	});

	it("未闭合的字符串与注释报错", () => {
		expectError(`{"a": "abc`, "Unterminated string");
		expectError(`/* 未闭合 `, "Unterminated block comment");
	});

	it("空文件与多余内容报错", () => {
		expectError(``, "Empty file");
		expectError(`{} extra`, "Unexpected content after");
	});

	it("非法转义与 \\\\u 报错", () => {
		expectError(`{"a": "\\x"}`, "Unsupported escape");
		expectError(`{"a": "\\u12g4"}`, "4 hex digits");
	});

	it("无法识别的词报错", () => {
		expectError(`{"a": tru}`, "Unrecognized value tru");
	});

	it("裸控制字符报错", () => {
		expectError(`{"a": "a\tb"}`, "Raw control character");
	});

	it("__proto__ 是普通键，不改写原型", () => {
		const { value } = parse(`{"__proto__": {"polluted": 2}}`);
		assert.equal(Object.getPrototypeOf(value), Object.prototype);
		assert.equal(Object.hasOwn(value as object, "__proto__"), true);
		assert.deepEqual((value as JsonObject)["__proto__"], { polluted: 2 });
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	});
});
