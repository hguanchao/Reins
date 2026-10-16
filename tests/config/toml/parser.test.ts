import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../../src/config/config-error.ts";
import { TomlParser } from "../../../src/config/toml/parser.ts";

/** 解析并直接取根表，省去每个用例都写一遍 .parse().root。 */
function parseRoot(source: string): Record<string, unknown> {
	return new TomlParser(source).parse().root as Record<string, unknown>;
}

function expectError(source: string, messagePart: string, line?: number): ConfigError {
	try {
		new TomlParser(source).parse();
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

describe("TomlParser 顶层结构", () => {
	it("解析顶层键值并忽略注释与空行", () => {
		const root = parseRoot(`
# 开头注释
provider = "example-openai"

model = "gpt-5.2"   # 行尾注释

`);
		assert.deepEqual(root, { provider: "example-openai", model: "gpt-5.2" });
	});

	it("没有结尾换行也能解析", () => {
		assert.deepEqual(parseRoot('provider = "x"'), { provider: "x" });
	});

	it("空文件解析成空表", () => {
		assert.deepEqual(parseRoot(""), {});
		assert.deepEqual(parseRoot("\n\n# 只有注释\n"), {});
	});

	it("键可以用引号包裹", () => {
		assert.deepEqual(parseRoot('"a b" = 1'), { "a b": 1 });
		assert.deepEqual(parseRoot("'c.d' = 2"), { "c.d": 2 });
	});
});

describe("TomlParser 字符串", () => {
	it("基本字符串支持转义", () => {
		assert.deepEqual(parseRoot('a = "行1\\n行2\\t制表 \\"引号\\" \\\\ 反斜杠"'), {
			a: '行1\n行2\t制表 "引号" \\ 反斜杠',
		});
	});

	it("基本字符串支持 Unicode 转义", () => {
		assert.deepEqual(parseRoot('a = "\\u4E2D\\U0001F600"'), { a: "\u4E2D\uD83D\uDE00" });
	});

	it("字面量字符串不处理转义", () => {
		assert.deepEqual(parseRoot("a = 'C:\\Users\\x'"), { a: "C:\\Users\\x" });
	});

	it("多行基本字符串会去掉紧跟定界符的换行", () => {
		assert.deepEqual(parseRoot('a = """\n第一行\n第二行\n"""'), { a: "第一行\n第二行\n" });
	});

	it("多行基本字符串的行尾反斜杠会吃掉后续空白", () => {
		assert.deepEqual(parseRoot('a = """\n折行 \\\n     接上\n"""'), { a: "折行 接上\n" });
	});

	it("多行字面量字符串保留反斜杠", () => {
		assert.deepEqual(parseRoot("a = '''\nC:\\x\n'''"), { a: "C:\\x\n" });
	});

	it("多行字符串允许在结尾带多余的引号", () => {
		assert.deepEqual(parseRoot('a = """内容""""'), { a: '内容"' });
		assert.deepEqual(parseRoot("a = '''内容''''"), { a: "内容'" });
	});
});

describe("TomlParser 数字与布尔", () => {
	it("解析各种进制的整数", () => {
		assert.deepEqual(parseRoot("a = 42\nb = -7\nc = 0\nd = 0x1F\ne = 0o17\nf = 0b1011\ng = 1_000_000"), {
			a: 42,
			b: -7,
			c: 0,
			d: 31,
			e: 15,
			f: 11,
			g: 1000000,
		});
	});

	it("解析浮点数", () => {
		const root = parseRoot("a = 3.14\nb = -0.5\nc = 1e3\nd = 2.5e-2");
		assert.equal(root.a, 3.14);
		assert.equal(root.b, -0.5);
		assert.equal(root.c, 1000);
		assert.equal(root.d, 0.025);
	});

	it("解析 inf 与 nan", () => {
		const root = parseRoot("a = inf\nb = -inf\nc = nan");
		assert.equal(root.a, Number.POSITIVE_INFINITY);
		assert.equal(root.b, Number.NEGATIVE_INFINITY);
		assert.ok(Number.isNaN(root.c));
	});

	it("解析布尔", () => {
		assert.deepEqual(parseRoot("a = true\nb = false"), { a: true, b: false });
	});
});

describe("TomlParser 数组与内联表", () => {
	it("解析单行与跨行数组，允许结尾逗号", () => {
		assert.deepEqual(parseRoot("a = [1, 2, 3]"), { a: [1, 2, 3] });
		assert.deepEqual(parseRoot("a = [\n  1,\n  2,  # 注释\n  3,\n]"), { a: [1, 2, 3] });
		assert.deepEqual(parseRoot("a = []"), { a: [] });
	});

	it("解析嵌套数组与异构元素", () => {
		assert.deepEqual(parseRoot('a = [[1, 2], ["x"], { b = 3 }]'), { a: [[1, 2], ["x"], { b: 3 }] });
	});

	it("解析内联表，包括嵌套", () => {
		assert.deepEqual(parseRoot('a = { b = 1, c = { d = "x" } }'), { a: { b: 1, c: { d: "x" } } });
		assert.deepEqual(parseRoot("a = {}"), { a: {} });
	});

	it("配置里常见的带点键内联表", () => {
		assert.deepEqual(parseRoot("a = { x.y = 1 }"), { a: { x: { y: 1 } } });
	});
});

describe("TomlParser 表", () => {
	it("解析表与嵌套表", () => {
		assert.deepEqual(parseRoot("[ui]\nnotify = \"auto\"\n\n[mcp_servers.context7]\ncommand = \"npx\"\n"), {
			ui: { notify: "auto" },
			mcp_servers: { context7: { command: "npx" } },
		});
	});

	it("同一父表下的多张子表合并", () => {
		assert.deepEqual(parseRoot("[a.b]\nx = 1\n[a.c]\ny = 2\n"), { a: { b: { x: 1 }, c: { y: 2 } } });
	});

	it("点分键创建嵌套表", () => {
		assert.deepEqual(parseRoot("a.b.c = 1"), { a: { b: { c: 1 } } });
	});

	it("解析数组表并追加", () => {
		assert.deepEqual(parseRoot("[[s]]\nx = 1\n[[s]]\nx = 2\n"), {
			s: [{ x: 1 }, { x: 2 }],
		});
	});

	it("表头路径允许带引号的段", () => {
		assert.deepEqual(parseRoot('[a."b c"]\nx = 1'), { a: { "b c": { x: 1 } } });
	});

	it("区段记录自己的表头位置与插入点", () => {
		const result = new TomlParser('provider = "x"\n\n# 说明\n[ui]\nnotify = "auto"\n').parse();
		assert.equal(result.sections.length, 2);

		const [root, ui] = result.sections;
		assert.equal(root.path, null);
		// 根区段的插入点紧跟最后一条条目，不会被后面的空行与注释推走
		assert.equal(root.bodyEnd, 'provider = "x"\n'.length);
		assert.deepEqual(ui.path, ["ui"]);
		assert.equal(ui.bodyEnd, 'provider = "x"\n\n# 说明\n[ui]\nnotify = "auto"\n'.length);
	});
});

describe("TomlParser 拒绝非法输入", () => {
	it("拒绝重复的键", () => {
		expectError("a = 1\na = 2\n", "重复定义", 2);
	});

	it("拒绝重复定义的表", () => {
		expectError("[ui]\nnotify = \"a\"\n[ui]\n", "重复定义", 3);
	});

	it("拒绝把已存在的路径当表头", () => {
		expectError("[a.b]\nx = 1\n[a]\n", "重复定义", 3);
	});

	it("拒绝用表头覆盖普通值", () => {
		expectError("a = 1\n[a.b]\n", "已被非表的值占用");
	});

	it("拒绝在值里继续用点分键", () => {
		expectError("a = 1\na.b = 2\n", "已被非表的值占用");
	});

	it("拒绝未闭合的字符串", () => {
		expectError('a = "没有结尾\n', "不能跨行");
		expectError('a = """没有结尾', "没有闭合");
	});

	it("拒绝不支持的转义", () => {
		expectError('a = "\\q"', "不支持的转义");
	});

	it("拒绝日期与时间类型", () => {
		expectError("a = 2024-01-02", "不支持日期");
		expectError('a = 12:30:00', "不支持时间");
	});

	it("拒绝缺少等号的赋值", () => {
		expectError("a 1\n", "需要等号");
	});

	it("拒绝表头后跟多余内容", () => {
		expectError("[ui] notify\n", "只能跟换行");
	});

	it("拒绝一行里出现两个赋值", () => {
		expectError("a = 1 b = 2\n", "只能跟换行");
	});

	it("拒绝前导零的整数", () => {
		expectError("a = 01\n", "无法识别的值");
	});

	it("拒绝跨行的内联表", () => {
		expectError("a = { b = 1,\n c = 2 }\n", "内联表");
	});

	it("报错时给出从 1 开始的行列号", () => {
		const error = expectError("a = 1\nb = @\n", "无法识别的值");
		assert.equal(error.line, 2);
		assert.equal(error.column, 5);
	});
});

describe("TomlParser 行尾", () => {
	it("接受 CRLF 行尾", () => {
		const root = parseRoot('provider = "x"\r\n\r\n[ui]\r\nnotify = "auto"\r\n');
		assert.deepEqual(root, { provider: "x", ui: { notify: "auto" } });
	});

	it("CRLF 下多行字符串的折行按一行算", () => {
		// 行尾反斜杠连同行尾一起吃掉，但闭合定界符前那个换行属于内容，按原文的 CRLF 保留
		assert.deepEqual(parseRoot('a = """\r\n折行 \\\r\n     接上\r\n"""'), { a: "折行 接上\r\n" });
	});

	it("CRLF 下报错的行号仍然正确", () => {
		const error = expectError('a = "x"\r\nb = @\r\n', "无法识别的值");
		assert.equal(error.line, 2);
	});

	it("区分 CRLF 与 LF 混用时的空白行", () => {
		const result = new TomlParser('provider = "x"\r\n[ui]\r\nnotify = "auto"\r\n').parse();
		assert.equal(result.sections[0].bodyEnd, 'provider = "x"\r\n'.length);
	});
});
