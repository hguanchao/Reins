import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightSourceLines, renderMarkdown } from "../../../src/plugins/tui-plugin/markdown.ts";
import { THEME } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText, lineWidth, type Line } from "../../../src/tui/text/line.ts";

function findLine(lines: readonly Line[], needle: string): Line | undefined {
	return lines.find((line) => lineText(line).includes(needle));
}

function findSpan(line: Line | undefined, needle: string): Line[number] | undefined {
	return line?.find((span) => span.text.includes(needle));
}

describe("Markdown 渲染", () => {
	it("标题按级别使用主题色", () => {
		const { lines } = renderMarkdown("# One\n\n## Two\n\n### Three", { width: 40 });

		assert.equal(findSpan(findLine(lines, "One"), "One")?.style?.color, THEME.mdTeal);
		assert.equal(findSpan(findLine(lines, "Two"), "Two")?.style?.color, THEME.system);
		assert.equal(findSpan(findLine(lines, "Three"), "Three")?.style?.color, THEME.accent);
	});

	it("代码块有底色并铺满正文宽度，关键字按语法着色", () => {
		const { lines } = renderMarkdown("```ts\nconst x = 1;\n```", { width: 20 });
		const code = findLine(lines, "const x = 1;");

		assert.ok(code);
		assert.equal(lineWidth(code), 20);
		assert.ok(code.every((span) => span.style?.background === THEME.codeBg));
		assert.equal(findSpan(code, "const")?.style?.color, THEME.accent);
	});

	it("任务列表的勾选状态用成功色，未勾选压暗", () => {
		const { lines } = renderMarkdown("- [x] done\n- [ ] todo", { width: 40 });

		assert.equal(findSpan(findLine(lines, "[x]"), "[x]")?.style?.color, THEME.ok);
		assert.equal(findSpan(findLine(lines, "[ ]"), "[ ]")?.style?.dim, true);
	});

	it("删除线、行内代码与链接各自带上内联样式", () => {
		const { lines } = renderMarkdown("~~gone~~ `code` [docs](https://example.com)", { width: 60 });

		assert.equal(findSpan(findLine(lines, "gone"), "gone")?.style?.strikethrough, true);
		assert.equal(findSpan(findLine(lines, "code"), "code")?.style?.color, THEME.code);
		const link = findSpan(findLine(lines, "docs"), "docs");
		assert.equal(link?.style?.color, THEME.system);
		assert.equal(link?.style?.underline, true);
		assert.equal(link?.style?.link, "https://example.com");

		const image = renderMarkdown("![diagram](https://example.com/a.png)", { width: 60 });
		const placeholder = findSpan(findLine(image.lines, "[image: diagram]"), "[image: diagram]");
		assert.equal(placeholder?.style?.link, "https://example.com/a.png");
	});

	it("紧凑列表项之间不插空行，松散列表保留分段", () => {
		const tight = renderMarkdown("- one\n- two", { width: 40 });
		assert.equal(tight.lines.length, 2);

		const loose = renderMarkdown("- one\n\n- two", { width: 40 });
		assert.ok(loose.lines.length > 2);
	});

	it("表格画成盒线，表头加粗，下面带复制操作行", () => {
		const source = "| A | B |\n| - | - |\n| 1 | 2 |";
		const { lines, copies } = renderMarkdown(source, { width: 40 });

		assert.ok(findLine(lines, "┌"), "top border");
		assert.ok(findLine(lines, "├"), "row separator");
		assert.ok(findLine(lines, "└"), "bottom border");
		const headerCell = findSpan(findLine(lines, "A"), "A");
		assert.equal(headerCell?.style?.bold, true);

		const row = findLine(lines, "│ 1");
		assert.ok(row, "body cell inside the grid");
		assert.equal(copies.length, 3);
		assert.deepEqual(
			copies.map((copy) => copy.content),
			["A\tB\n1\t2", "A,B\n1,2", source],
		);
		// 方括号标签的列范围正好覆盖 [Copy …] 文本
		const csvRow = lines[copies[1].line];
		assert.equal(lineText(csvRow).slice(copies[1].from, copies[1].to), "[Copy CSV]");
	});

	it("分隔线只画三格", () => {
		const { lines } = renderMarkdown("above\n\n---\n\nbelow", { width: 60 });
		const rule = findLine(lines, "───");
		assert.ok(rule);
		assert.equal(lineWidth(rule), 3);
	});

	it("链接正文后跟灰色括注地址", () => {
		const { lines } = renderMarkdown("[docs](https://example.com)", { width: 60 });
		const suffix = findSpan(findLine(lines, "(https://example.com)"), "(https://example.com)");
		assert.ok(suffix);
		assert.equal(suffix?.style?.color, THEME.muted);
	});

	it("引用块压暗，表格表头加粗", () => {
		const quote = renderMarkdown("> note", { width: 40 });
		const quoted = findSpan(findLine(quote.lines, "note"), "note");
		assert.ok(lineText(findLine(quote.lines, "note")!).startsWith("│ "));
		assert.equal(quoted?.style?.dim, true);
		assert.equal(quoted?.style?.color, THEME.muted);

		const table = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |", { width: 40 });
		const header = findSpan(findLine(table.lines, "A"), "A");
		assert.equal(header?.style?.bold, true);
		assert.equal(header?.style?.color, THEME.bright);
	});
});

describe("文件正文按类型着色", () => {
	it("按扩展名挑语言：ts 的关键字与字符串各有着色", () => {
		const lines = highlightSourceLines('const s = "hi";', "src/a.ts", { color: THEME.text });
		const colors = lines[0].map((span) => span.style?.color);
		assert.ok(colors.includes(THEME.accent), `关键字上色: ${JSON.stringify(lines[0])}`);
		assert.ok(colors.includes(THEME.ok), `字符串上色: ${JSON.stringify(lines[0])}`);
	});

	it("认不出扩展名时整段按给定底色画", () => {
		const lines = highlightSourceLines("const s = 1;", "notes.unknownext", { color: THEME.text });
		assert.deepEqual(
			lines[0].map((span) => span.style?.color),
			[THEME.text],
		);
	});

	it("没有扩展名的文件也按底色画", () => {
		const lines = highlightSourceLines("hello", "Makefile", { color: THEME.text });
		assert.deepEqual(
			lines[0].map((span) => span.style?.color),
			[THEME.text],
		);
	});
});
