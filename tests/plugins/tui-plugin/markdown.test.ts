import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMarkdown } from "../../../src/plugins/tui-plugin/markdown.ts";
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

		assert.equal(findSpan(findLine(lines, "One"), "One")?.style?.color, THEME.teal);
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
	});

	it("紧凑列表项之间不插空行，松散列表保留分段", () => {
		const tight = renderMarkdown("- one\n- two", { width: 40 });
		assert.equal(tight.lines.length, 2);

		const loose = renderMarkdown("- one\n\n- two", { width: 40 });
		assert.ok(loose.lines.length > 2);
	});

	it("表格按对齐方式补空格", () => {
		const { lines } = renderMarkdown("| A | Long |\n| - | ---: |\n| 1 | 2 |", { width: 40 });
		const row = findLine(lines, "1");
		assert.ok(row);
		assert.ok(lineText(row).includes("│    2"), lineText(row));
	});

	it("引用块压暗，表格表头用二级标题样式", () => {
		const quote = renderMarkdown("> note", { width: 40 });
		const quoted = findSpan(findLine(quote.lines, "note"), "note");
		assert.ok(lineText(findLine(quote.lines, "note")!).startsWith("│ "));
		assert.equal(quoted?.style?.dim, true);
		assert.equal(quoted?.style?.color, THEME.muted);

		const table = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |", { width: 40 });
		const header = findSpan(findLine(table.lines, "A"), "A");
		assert.equal(header?.style?.bold, true);
		assert.equal(header?.style?.color, THEME.system);
	});
});
