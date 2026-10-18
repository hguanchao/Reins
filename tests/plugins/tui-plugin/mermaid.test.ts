import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMermaid } from "../../../src/plugins/tui-plugin/mermaid.ts";
import { renderMarkdown } from "../../../src/plugins/tui-plugin/markdown.ts";
import { lineText } from "../../../src/tui/text/line.ts";

const CHAIN = `graph TD
  A[Start] --> B[Work] --> C[Done]`;

describe("Mermaid 预览", () => {
	it("自上而下的链式图画出盒子与箭头", () => {
		const lines = renderMermaid(CHAIN, 60);
		assert.ok(lines);
		const text = lines.map(lineText).join("\n");
		assert.ok(text.includes("┌") && text.includes("┐"));
		assert.ok(text.includes("Start"));
		assert.ok(text.includes("Work"));
		assert.ok(text.includes("Done"));
		assert.ok(text.includes("▼"));
	});

	it("分支画在同一层，边标签放在图下方的图例里", () => {
		const lines = renderMermaid(
			`graph TD
			 A[Start] --> B{Ready?}
			 B -->|yes| C[Run]
			 B -->|no| D[Wait]`,
			70,
		);
		assert.ok(lines);
		const text = lines.map(lineText).join("\n");
		assert.ok(text.includes("Run") && text.includes("Wait"));
		assert.ok(text.includes("yes: Ready? → Run"));
		assert.ok(text.includes("no: Ready? → Wait"));
	});

	it("左右布局、环与子图退回源码", () => {
		assert.equal(renderMermaid("graph LR\n A-->B", 60), undefined);
		assert.equal(renderMermaid("graph TD\n A-->B\n B-->A", 60), undefined);
		assert.equal(renderMermaid("graph TD\n subgraph one\n A-->B\n end", 60), undefined);
	});

	it("放不下时退回源码", () => {
		assert.equal(renderMermaid("graph TD\n A[A very long label that will not fit] --> B", 20), undefined);
	});

	it("Markdown 里的 mermaid 块走图形预览，并提供复制源码", () => {
		const { lines } = renderMarkdown("```mermaid\ngraph TD\n A[Start] --> B[Done]\n```", { width: 60 });
		const text = lines.map(lineText).join("\n");
		assert.ok(text.includes("Start") && text.includes("Done"));
		assert.ok(text.includes("Copy Source"));
		assert.ok(!text.includes("graph TD"), "source is replaced by the diagram");
	});

	it("不支持的 mermaid 仍显示源码块", () => {
		const { lines } = renderMarkdown("```mermaid\ngraph LR\n A-->B\n```", { width: 60 });
		const text = lines.map(lineText).join("\n");
		assert.ok(text.includes("graph LR"), text);
	});
});
