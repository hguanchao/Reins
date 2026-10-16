import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMarkdown } from "../../../src/plugins/tui-plugin/markdown.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

function texts(markdown: string, width = 40): string[] {
	return renderMarkdown(markdown, { width }).lines.map((line) => lineText(line));
}

describe("renderMarkdown 块级结构", () => {
	it("标题画成加粗文本，不显示井号", () => {
		const lines = renderMarkdown("# 标题\n", { width: 20 }).lines;
		assert.deepEqual(lines.map((line) => lineText(line)), ["标题"]);
		assert.deepEqual(lines[0][0].style, { bold: true, underline: true });
	});

	it("段落之间的空行由渲染补上", () => {
		assert.deepEqual(texts("第一段\n\n第二段\n"), ["第一段", "", "第二段"]);
	});

	it("列表带标记，折行与标记对齐", () => {
		assert.deepEqual(texts("- 甲\n- 乙乙乙乙乙乙乙乙乙乙\n", 12), [
			"• 甲",
			"",
			"• 乙乙乙乙乙",
			"  乙乙乙乙乙",
		]);
	});

	it("有序列表按起始序号编号", () => {
		assert.deepEqual(texts("3. 甲\n4. 乙\n"), ["3. 甲", "", "4. 乙"]);
	});

	it("嵌套列表与父项的文字对齐，不再重复标记", () => {
		assert.deepEqual(texts("- 甲\n  - 乙\n"), ["• 甲", "", "  • 乙"]);
	});

	it("任务列表画出勾选状态", () => {
		assert.deepEqual(texts("- [x] 做完\n- [ ] 没做\n"), ["• [x] 做完", "", "• [ ] 没做"]);
	});

	it("代码块带竖线，缩进保留", () => {
		assert.deepEqual(texts("```ts\nconst a = 1;\n  let b = 2;\n```\n"), [
			"│ const a = 1;",
			"│   let b = 2;",
		]);
	});

	it("引用带前缀且整段压低", () => {
		const lines = renderMarkdown("> 引用\n> 第二行\n", { width: 20 }).lines;
		assert.deepEqual(lines.map((line) => lineText(line)), ["▏ 引用", "▏ 第二行"]);
		// 前缀与内容的样式相同，文本层会把它们合成一段
		assert.equal(lines[0][0].style?.dim, true);
	});

	it("表格按行列出来", () => {
		assert.deepEqual(texts("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n", 20), [
			"甲 │ 乙",
			"────────────────────────────────────────".slice(0, 20).replace(/─+$/, "─".repeat(20)),
			"1 │ 2",
		]);
	});

	it("分隔线是一串横线", () => {
		const lines = renderMarkdown("---\n", { width: 10 }).lines;
		assert.equal(lineText(lines[0]), "─".repeat(10));
	});
});

describe("renderMarkdown 行内样式", () => {
	it("粗体、斜体、行内代码与链接各自带上样式", () => {
		const line = renderMarkdown("普通 **粗** *斜* `码` [链](https://x)\n", { width: 60 }).lines[0];
		assert.deepEqual(
			line.map((span) => [span.text, span.style ?? null]),
			[
				["普通 ", null],
				["粗", { bold: true }],
				[" ", null],
				["斜", { italic: true }],
				[" ", null],
				["码", { color: "cyan" }],
				[" ", null],
				["链", { underline: true }],
			],
		);
	});

	it("行内样式与整块样式叠加", () => {
		const line = renderMarkdown("> 引用里的 **强调**\n", { width: 40 }).lines[0];
		const strong = line.find((span) => span.text === "强调");
		assert.equal(strong?.style?.bold, true);
		assert.equal(strong?.style?.dim, true);
	});

	it("HTML 与表格里的行内记号不丢内容", () => {
		assert.deepEqual(texts("<b>原文</b>\n", 40), ["<b>原文</b>"]);
	});
});

describe("renderMarkdown 折行与宽度", () => {
	it("每行都不超过给定宽度", () => {
		const sample = [
			"# 标题标题标题标题标题",
			"",
			"- 列表项内容很长，长到必须折行才算放得下，还要检查悬挂缩进",
			"",
			"> 引用内容也长，长到折行，前缀要留在每一行上",
			"",
			"```",
			"一行很长很长的代码，长到必须折行，续行也要有竖线",
			"```",
		].join("\n");

		for (const width of [12, 24, 40]) {
			for (const line of renderMarkdown(sample, { width }).lines) {
				assert.ok(lineWidth(line) <= width, `宽度 ${width} 下超宽：${lineText(line)}`);
			}
		}
	});

	it("中文按两列计算宽度", () => {
		assert.deepEqual(texts("一二三四五六", 6), ["一二三", "四五六"]);
	});
});

describe("renderMarkdown 流式稳定性", () => {
	it("写完的块算稳定，最后一块的最后一行不算", () => {
		const rendered = renderMarkdown("第一段\n\n第二段还在写", { width: 20 });
		assert.equal(rendered.lines.length, 3);
		// 第一段与空行稳定；第二段只有一行，且是最后一行
		assert.equal(rendered.stableLines, 2);
	});

	it("纯文本的最后一块里，除最后一行外都可以先交出去", () => {
		const rendered = renderMarkdown("一二三四五六七八九十", { width: 6 });
		assert.equal(rendered.lines.length, 4);
		assert.equal(rendered.stableLines, 3);
	});

	it("带行内标记的那一块保守处理：整块都不算稳定", () => {
		const rendered = renderMarkdown("一二三四五六七八**九十", { width: 6 });
		assert.equal(rendered.lines.length, 4);
		assert.equal(rendered.stableLines, 0);
	});

	it("代码块里即使有星号也只按换行判断", () => {
		const rendered = renderMarkdown("```\n** * *\n一二三四五", { width: 8 });
		assert.equal(rendered.stableLines, rendered.lines.length - 1);
	});
});

describe("renderMarkdown 与文本层的配合", () => {
	it("空输入不产生任何行", () => {
		assert.deepEqual(renderMarkdown("", { width: 20 }).lines, []);
	});

	it("只渲染不改动输入", () => {
		const source = "**粗**\n";
		renderMarkdown(source, { width: 20 });
		assert.equal(source, "**粗**\n");
	});

	it("同一段文本渲染两次得到完全相同的结果", () => {
		const a = renderMarkdown("- 甲\n", { width: 20 }).lines[0];
		const b = renderMarkdown("- 甲\n", { width: 20 }).lines[0];
		assert.deepEqual(a, b);
	});
});
