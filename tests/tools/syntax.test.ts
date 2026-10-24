import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightCode, languageForPath } from "../../src/tools/syntax.ts";

describe("语言推断", () => {
	it("按扩展名认出常见语言", () => {
		assert.equal(languageForPath("src/a.ts"), "typescript");
		assert.equal(languageForPath("a.mts"), "typescript");
		assert.equal(languageForPath("a.tsx"), "typescript");
		assert.equal(languageForPath("a.js"), "javascript");
		assert.equal(languageForPath("a.py"), "python");
		assert.equal(languageForPath("a.rs"), "rust");
		assert.equal(languageForPath("作文.md"), "markdown");
		assert.equal(languageForPath("C:\\work\\config.yaml"), "yaml");
		assert.equal(languageForPath("a.toml"), "ini");
	});

	it("没有扩展名时看文件名本身", () => {
		assert.equal(languageForPath("Dockerfile"), "dockerfile");
		assert.equal(languageForPath("path/to/Makefile"), "makefile");
	});

	it("认不出时返回 undefined，不猜", () => {
		assert.equal(languageForPath("README"), undefined);
		assert.equal(languageForPath("a.unknownext"), undefined);
		assert.equal(languageForPath(".bashrc"), undefined);
		assert.equal(languageForPath(""), undefined);
	});
});

describe("代码着色", () => {
	it("按行返回，行数与输入一一对应", () => {
		const lines = highlightCode("const a = 1;\n\nconst b = 2;", "a.ts");
		assert.equal(lines?.length, 3);
		assert.deepEqual(lines?.[1], []);
	});

	it("关键字、数字、字符串分别给出角色", () => {
		const lines = highlightCode('const name = "x";', "a.ts");
		const tokens = lines?.[0] ?? [];
		const byText = new Map(tokens.map((segment) => [segment.text, segment.token]));

		assert.equal(byText.get("const"), "keyword");
		assert.equal(byText.get('"x"'), "string");
	});

	it("JSON 键名单独给出属性角色", () => {
		const lines = highlightCode('{\n  "name": "reins",\n  "count": 2\n}', "a.json");
		const key = lines?.[1]?.find((segment) => segment.text === '"name"');
		const string = lines?.[1]?.find((segment) => segment.text === '"reins"');
		const number = lines?.[2]?.find((segment) => segment.text === "2");

		assert.equal(key?.token, "property");
		assert.equal(string?.token, "string");
		assert.equal(number?.token, "number");
	});

	it("注释跨行时后续行仍然是注释", () => {
		const lines = highlightCode("/*\n  说明\n*/\nconst a = 1;", "a.ts");
		assert.equal(lines?.[1]?.every((segment) => segment.token === "comment"), true);
		assert.equal(lines?.[2]?.every((segment) => segment.token === "comment"), true);
		assert.equal(lines?.[3]?.some((segment) => segment.token === "keyword"), true);
	});

	it("认不出语言时返回 undefined，调用方按纯文本渲染", () => {
		assert.equal(highlightCode("whatever", "README"), undefined);
	});

	it("纯中文 Markdown 段落不着色，整段是普通正文", () => {
		const lines = highlightCode("我家老屋后头，立着一棵槐树。", "作文.md");
		assert.equal(lines?.[0]?.every((segment) => segment.token === undefined), true);
	});

	it("同一段代码重复调用结果一致", () => {
		const first = highlightCode("const a = 1;", "a.ts");
		const second = highlightCode("const a = 1;", "a.ts");
		assert.deepEqual(first, second);
	});
});
