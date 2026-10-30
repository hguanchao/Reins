import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TomlParser } from "#src/config/toml/parser.ts";
import { serializeKey, serializeValue } from "#src/config/toml/serialize.ts";
import { ConfigError } from "#src/config/error.ts";

function parse(source: string) {
	try {
		return new TomlParser(source).parse();
	} catch (error) {
		if (error instanceof ConfigError) throw new Error(error.display);
		throw error;
	}
}

function expectError(source: string, expected: string): void {
	assert.throws(() => parse(source), (error: unknown) => error instanceof Error && error.message.includes(expected));
}

describe("TOML 解析", () => {
	it("基本赋值与表头", () => {
		const { root } = parse(`model = "gpt"\n[ui]\nnotify = "bell"\n`);
		assert.deepEqual(root, { model: "gpt", ui: { notify: "bell" } });
	});

	it("点分键展开成嵌套表", () => {
		const { root } = parse(`a.b.c = 1`);
		assert.deepEqual(root, { a: { b: { c: 1 } } });
	});

	it("数组与内联表", () => {
		const { root } = parse(`steps = [1, 2, 3]\ninline = { x = 1, y = "z" }`);
		assert.deepEqual(root, { steps: [1, 2, 3], inline: { x: 1, y: "z" } });
	});

	it("带引号的键", () => {
		const { root } = parse(`"a.b" = 1`);
		assert.deepEqual(root, { "a.b": 1 });
	});

	it("数组内的注释与换行", () => {
		const { root } = parse(`steps = [\n  1, # first\n  2,\n]`);
		assert.deepEqual(root, { steps: [1, 2] });
	});

	it("数组表 [[seg]] 追加元素", () => {
		const { root } = parse(`[[seg]]\nx = 1\n[[seg]]\nx = 2`);
		assert.deepEqual(root, { seg: [{ x: 1 }, { x: 2 }] });
	});

	it("数字：下划线、十六进制与前缀符号", () => {
		const { root } = parse(`a = 1_000\nb = 0xFF\nc = -7\nd = +1.5`);
		assert.deepEqual(root, { a: 1000, b: 255, c: -7, d: 1.5 });
	});

	it("多行字符串吃掉行尾折行", () => {
		const { root } = parse('s = """first\\\nsecond"""');
		assert.deepEqual(root, { s: "firstsecond" });
	});

	it("普通多行字符串保留换行", () => {
		const { root } = parse('s = """a\nb"""');
		assert.deepEqual(root, { s: "a\nb" });
	});

	it("字面量字符串不转义", () => {
		const { root } = parse('s = \'a\\nb\'');
		assert.deepEqual(root, { s: "a\\nb" });
	});

	it("记录赋值与区段位置，供回写使用", () => {
		const source = `a = "x"\n\n[ui]\nnotify = "bell"\n`;
		const result = parse(source);
		assert.deepEqual(result.assignments.map((a) => a.path), [["a"], ["ui", "notify"]]);
		const aAssignment = result.assignments[0]!;
		assert.equal(aAssignment.valueStart, source.indexOf('"x"'));
		const uiSection = result.sections.find((s) => s.path !== null && s.path.join(".") === "ui");
		assert.ok(uiSection);
	});

	it("重复键与重复表头报错", () => {
		expectError(`a = 1\na = 2`, "Duplicate key");
		expectError(`[t]\n[t]`, "Duplicate definition");
	});

	it("点分键定义的表不能被表头再定义", () => {
		expectError(`a.b = 1\n[a]`, "Duplicate definition");
		expectError(`a.b = 1\n[a.b]`, "Duplicate definition");
	});

	it("已经写出的内联表不能再追加", () => {
		expectError(`a = { x = 1 }\n[a.b]`, "cannot be extended");
	});

	it("值被别的类型占了报错", () => {
		expectError(`a = 1\n[a.b]`, "already taken by a non-table value");
	});

	it("日期与时间不支持", () => {
		expectError(`a = 1990-01-01`, "Date");
		expectError(`a = 01:04:20`, "Time");
	});

	it("缺值、缺等号报错", () => {
		expectError(`a = `, "Missing value");
		expectError(`a "b"`, "equals sign");
	});

	it("坐标：错误指到行列", () => {
		// expectError 会把 ConfigError 包成普通 Error，这里直接试并保留原始错误类型
		assert.throws(() => new TomlParser(`a = 1\nbad`).parse(), (error: unknown) => {
			assert.ok(error instanceof ConfigError);
			assert.equal(error.line, 2);
			return true;
		});
	});

	it("__proto__ 是普通键，不改写原型", () => {
		const { root } = parse(`__proto__.polluted = 1`);
		assert.equal(Object.getPrototypeOf(root), Object.prototype);
		assert.equal(Object.hasOwn(root, "__proto__"), true);
		assert.deepEqual(root["__proto__"], { polluted: 1 });
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	});
});

describe("TOML 序列化", () => {
	it("裸键直接输出，其余加引号", () => {
		assert.equal(serializeKey("model"), "model");
		assert.equal(serializeKey("a.b"), '"a.b"');
		assert.equal(serializeKey("中文"), '"中文"');
	});

	it("标量值", () => {
		assert.equal(serializeValue("hi"), '"hi"');
		assert.equal(serializeValue(42), "42");
		assert.equal(serializeValue(true), "true");
		assert.equal(serializeValue(Number.NaN), "nan");
		assert.equal(serializeValue(Number.POSITIVE_INFINITY), "inf");
	});

	it("字符串里的控制字符补成 \\\\u 引码形式", () => {
		assert.equal(serializeValue("a\u0001b"), '"a\\u0001b"');
	});

	it("特殊字符转义", () => {
		assert.equal(serializeValue('say "hi"'), '"say \\"hi\\""');
		assert.equal(serializeValue("line\nbreak"), '"line\\nbreak"');
	});

	it("数组与内联表", () => {
		assert.equal(serializeValue([1, 2]), "[1, 2]");
		assert.equal(serializeValue({ a: 1, b: "x" }), '{ a = 1, b = "x" }');
	});

	it("嵌套数组", () => {
		assert.equal(serializeValue([[1], ["a"]]), "[[1], [\"a\"]]");
	});
});
