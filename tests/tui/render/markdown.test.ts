import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMarkdown } from "#src/tui/render/markdown.ts";
import { displayWidth } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";

function plain(line: string): string {
	return line
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

function render(markdown: string, width = 60): readonly string[] {
	return renderMarkdown(markdown, width);
}

function texts(lines: readonly string[]): string[] {
	return lines.map(plain);
}

describe("Markdown 排版", () => {
	it("六级标题各有颜色，H1–H5 加粗、H6 不加粗", () => {
		const lines = render("# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六");
		const find = (text: string): string => lines.find((line) => plain(line).trim() === text) ?? "";

		assert.ok(find("一").includes(THEME.accent));
		assert.ok(find("二").includes(THEME.path));
		assert.ok(find("三").includes(THEME.syntaxKeyword));
		assert.ok(find("四").includes(THEME.textSecondary));
		assert.ok(find("五").includes(THEME.textSubtle));
		assert.ok(find("六").includes(THEME.textDisabled));
		for (const text of ["一", "二", "三", "四", "五"]) assert.ok(find(text).includes("\x1b[1m"));
		assert.equal(find("六").includes("\x1b[1m"), false);
		assert.equal(find("一").includes("#"), false);
		assert.ok(lines.every((line) => displayWidth(plain(line)) === 60));
	});

	it("粗体、斜体、删除线与行内代码不再显示标记，行内代码蓝色加粗无底色", () => {
		const lines = render("这是**粗体**、*斜体*、~~删除线~~和 `code` 的段落");
		const row = lines[0] ?? "";
		const text = plain(row);

		assert.ok(text.includes("这是粗体、斜体、删除线和"));
		assert.equal(text.includes("**"), false);
		assert.equal(text.includes("*斜"), false);
		assert.equal(text.includes("~~"), false);
		assert.equal(text.includes("`"), false);
		assert.ok(row.includes("\x1b[1m"));
		assert.ok(row.includes("\x1b[3m"));
		assert.ok(row.includes("\x1b[9m"));
		assert.ok(row.includes(THEME.path));
		assert.equal(row.includes(THEME.surface), false);
	});

	it("链接文字带下划线，地址显示在括号里且弱化", () => {
		const row = render("[ok](https://a.example) 和 [bad](javascript:alert(1))")[0] ?? "";

		assert.ok(plain(row).includes("ok (https://a.example)"));
		assert.ok(plain(row).includes("bad (javascript:alert(1))"));
		assert.ok(row.includes("\x1b[4m"));
		assert.ok(row.includes("]8;;https://a.example"));
		assert.equal(row.includes("]8;;javascript"), false);
		assert.ok(row.includes(THEME.textSubtle));
	});

	it("裸链接不会重复显示地址", () => {
		const row = render("https://a.example")[0] ?? "";

		assert.equal(plain(row).trim(), "https://a.example");
		assert.ok(row.includes("]8;;https://a.example"));
	});

	it("无序、有序与嵌套列表按层级缩进", () => {
		const rows = texts(render("- A\n- B\n  - C\n\n1. one\n2. two", 40));
		const text = rows.join("\n");

		assert.ok(text.includes("  • A"));
		assert.ok(text.includes("  • B"));
		assert.ok(text.includes("    • C"));
		assert.ok(text.includes("  1. one"));
		assert.ok(text.includes("  2. two"));
	});

	it("列表续行与正文列对齐，且不超出宽度", () => {
		const width = 30;
		const lines = render(`- ${"一".repeat(30)}`, width);
		const rows = texts(lines);

		assert.ok((rows[0] ?? "").startsWith("  • 一"));
		assert.ok((rows[1] ?? "").startsWith("    "));
		assert.ok(lines.every((line) => displayWidth(plain(line)) === width));
	});

	it("代码块保留上下留白与正文缩进，底色使用更弱的一档", () => {
		const lines = render("```ts\nconst x: number = 1;\nconsole.log(x);\n```", 40);
		const text = texts(lines).join("\n");
		const codeRow = lines.find((line) => plain(line).includes("const x")) ?? "";

		assert.ok(text.includes("const x: number = 1;"));
		assert.ok(text.includes("console.log(x);"));
		assert.equal(text.includes("```"), false);
		assert.ok(lines.some((line) => line.includes(THEME.syntaxKeyword)));
		assert.ok(lines.every((line) => line.includes(THEME.codeBg) || plain(line).trim().length === 0));
		assert.equal(lines.join("").includes(THEME.surface), false);
		assert.ok(plain(codeRow).startsWith("   const x"));
	});

	it("认不出语言时代码块退回纯文本，不丢内容", () => {
		const rows = texts(render("```unknown\nplain  text\n```", 40));

		assert.ok(rows.some((line) => line.includes("plain  text")));
	});

	it("代码块里的制表符展开成空格，缩进层级保留", () => {
		const rows = texts(render("```py\n\tif x:\n\t\treturn 1\n```", 40));

		assert.ok(rows.some((line) => line.includes("    if x:")));
		assert.ok(rows.some((line) => line.includes("        return 1")));
	});

	it("引用内容每行带竖线，空行也带", () => {
		const rows = texts(render("> 第一行\n>\n> 第二行", 40));

		assert.ok(rows.some((line) => line.startsWith("  │ 第一行")));
		assert.ok(rows.some((line) => line === "  │".padEnd(40)));
		assert.ok(rows.some((line) => line.startsWith("  │ 第二行")));
	});

	it("分割线铺满内容区", () => {
		const line = render("---", 30)[0] ?? "";
		assert.equal(plain(line).trimStart().startsWith("─"), true);
		assert.equal(displayWidth(plain(line)), 30);
	});

	it("表格使用完整盒线、单元格左右留白并支持折行", () => {
		const rows = texts(render("| 名称 | 值 |\n| --- | ---: |\n| a | 1 |\n| 中文 | 22 |", 40));
		const text = rows.join("\n");

		assert.ok(text.includes("┌"));
		assert.ok(text.includes("┬"));
		assert.ok(text.includes("┼"));
		assert.ok(text.includes("└"));
		assert.ok(text.includes("│ 名称 │"));
		assert.ok(text.includes("│ a "));
		assert.ok(rows.every((line) => displayWidth(line) === 40));

		const narrow = render("| 名称 | 说明 |\n| --- | --- |\n| a | 这是一段需要换行的说明文字 |", 30);
		const narrowRows = texts(narrow);
		assert.ok(narrowRows.some((line) => line.includes("这是一段")));
		assert.ok(narrowRows.some((line) => line.includes("说明文字")));
		assert.ok(narrow.every((line) => displayWidth(plain(line)) === 30));
	});

	it("表格正文每行之间都有横线，形成全边框网格", () => {
		const rows = texts(render("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |", 40));
		const borders = rows.filter((line) => line.includes("┼"));
		const top = rows.find((line) => line.includes("┌")) ?? "";

		// 表头下 1 根 + 正文两行之间 1 根，共 2 根行间横线
		assert.equal(borders.length, 2);
		// 每根行间横线的 ┼ 与顶边框的 ┬ 对齐，且横线铺满整个表格宽度
		for (const border of borders) {
			assert.equal(border.indexOf("┼"), top.indexOf("┬"));
			assert.ok(border.trim().startsWith("├"));
			assert.ok(border.trim().endsWith("┤"));
		}
	});

	it("HTML 标签保留并高亮", () => {
		const row = render("行内 <b>粗</b> 文字")[0] ?? "";

		assert.ok(plain(row).includes("<b>粗</b>"));
		assert.ok(row.includes(THEME.syntaxType));

		const blockRows = texts(render("<div>块级 HTML</div>", 40));
		assert.ok(blockRows.some((line) => line.trim() === "<div>块级 HTML</div>"));
	});

	it("图片显示 [image: alt](url)，地址弱化", () => {
		const row = render("![截图](https://example.com/a.png)")[0] ?? "";

		assert.ok(plain(row).includes("[image: 截图](https://example.com/a.png)"));
		assert.ok(row.includes(THEME.textSubtle));
	});

	it("英文按单词折行，不在单词中间断开", () => {
		const rows = texts(render("hello world again", 14)).map((line) => line.trimEnd());

		assert.deepEqual(
			rows.filter((line) => line.trim().length > 0),
			["  hello world", "  again"],
		);
	});

	it("行内文本里的终端控制序列不会带进画面", () => {
		const raw = render("a\u001b[31mred\u001b]0;title\u0007b").join("");

		assert.equal(raw.includes("\u001b[31m"), false);
		assert.equal(raw.includes("\u001b]0;"), false);
		assert.ok(plain(raw).includes("aredb"));
	});

	it("任务列表的复选框不会重复成单独一行", () => {
		const rows = texts(render("- [x] 已完成\n- [ ] 待办", 40));

		assert.ok(rows.some((line) => line.startsWith("  [x] 已完成")));
		assert.ok(rows.some((line) => line.startsWith("  [ ] 待办")));
		assert.equal(rows.filter((line) => line.trim() === "[x]").length, 0);
	});

	it("行内 <br> 产生硬换行", () => {
		const rows = texts(render("换行<br>下一行", 40));

		assert.ok((rows[0] ?? "").includes("换行"));
		assert.ok((rows[1] ?? "").trimStart().startsWith("下一行"));
	});

	it("未闭合的代码围栏在流式过程中仍按代码块显示", () => {
		const rows = texts(render("```js\nconst a = 1"));

		assert.ok(rows.some((line) => line.includes("const a = 1")));
		assert.equal(rows.join("").includes("```"), false);
	});
});
