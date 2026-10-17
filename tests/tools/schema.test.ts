import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateToolArguments, type JsonSchema } from "../../src/tools/schema.ts";

const STRING_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		path: { type: "string" },
		count: { type: "integer", minimum: 1 },
		mode: { type: "string", enum: ["a", "b"] },
		price: { type: "number" },
		on: { type: "boolean" },
		list: { type: "array", items: { type: "string" } },
	},
	required: ["path"],
};

describe("工具参数校验", () => {
	it("通过时原样返回值", () => {
		const args = { path: "a.ts", count: 2, mode: "a", price: 1.5, on: true, list: ["x"] };
		const result = validateToolArguments(STRING_SCHEMA, args);
		assert.deepEqual(result, { ok: true, value: args });
	});

	it("缺必填时报错", () => {
		const result = validateToolArguments(STRING_SCHEMA, { count: 1 });
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.message : "", /missing the required key path/);
	});

	it("类型不对逐项列出问题", () => {
		const result = validateToolArguments(STRING_SCHEMA, {
			path: 1,
			count: "2",
			mode: "c",
			price: "x",
			on: 1,
			list: [1, "ok"],
		});
		assert.equal(result.ok, false);
		const messages = (result.ok === false ? result.message : "").split("\n");
		assert.ok(messages.some((m) => /path must be a string, got number/.test(m)));
		assert.ok(messages.some((m) => /count must be an integer, got string/.test(m)));
		assert.ok(messages.some((m) => /mode must be one of a, b/.test(m)));
	});

	it("integer 有最小值时给出至少几", () => {
		const result = validateToolArguments(STRING_SCHEMA, { path: "x", count: 0 });
		assert.match(result.ok === false ? result.message : "", /count must be at least 1, got 0/);
	});

	it("数组元素的位置写进问题里", () => {
		const result = validateToolArguments(STRING_SCHEMA, { path: "x", list: [1] });
		assert.match(result.ok === false ? result.message : "", /list\[0\] must be a string, got number/);
	});

	it("多余键报错并列出合法键", () => {
		const result = validateToolArguments(STRING_SCHEMA, { path: "x", wrong: true });
		assert.match(result.ok === false ? result.message : "", /unknown key wrong; valid keys: path/);
	});

	it("非对象参数直接拒", () => {
		for (const args of [null, [], "text", 1]) {
			const result = validateToolArguments(STRING_SCHEMA, args as unknown);
			assert.equal(result.ok, false);
			assert.match(result.ok === false ? result.message : "", /Arguments must be an object/);
		}
	});

	it("不声明 properties 的对象模式接受任何键；空 properties 什么都不接受", () => {
		// properties 缺省:是合法的 JSON Schema 写法,任何键都放行
		const open = { type: "object" } as unknown as JsonSchema;
		assert.deepEqual(validateToolArguments(open, { anything: 1 }), { ok: true, value: { anything: 1 } });

		// properties 是空表:声明了「没有任何合法键」
		const closed: JsonSchema = { type: "object", properties: {} };
		const result = validateToolArguments(closed, { anything: 1 });
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.message : "", /unknown key anything/);
	});
});
