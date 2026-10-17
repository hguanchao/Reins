import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Transcript } from "../../../src/plugins/tui-plugin/transcript.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("用户消息", () => {
	it("单行消息占三行，正文在中间", () => {
		const transcript = new Transcript(40);
		transcript.userTurn("hello");
		const rows = transcript.view().rows;

		assert.equal(rows.length, 3);
		assert.equal(lineText(rows[1]), `   › hello${" ".repeat(30)}`);
		assert.equal(lineText(rows[0]).trim(), "");
		assert.equal(lineText(rows[2]).trim(), "");
	});

	it("带 › 前缀，正文从块的竖线列之后开始", () => {
		const transcript = new Transcript(40);
		transcript.userTurn("hello");
		const rows = transcript.view().rows;

		assert.ok(lineText(rows[1]).startsWith("   › hello"));
	});

	it("整块铺底，每行都填满给定宽度", () => {
		const transcript = new Transcript(40);
		transcript.userTurn("hello");

		for (const row of transcript.view().rows) {
			assert.equal(lineWidth(row), 40);
			assert.ok(row.every((span) => span.style?.background !== undefined), "banded");
		}
	});

	it("多行消息上下各留一行，正文不截断，续行与提示符后的正文对齐", () => {
		const transcript = new Transcript(20);
		transcript.userTurn("one two three four");

		const rows = transcript.view().rows;
		assert.ok(rows.length > 3, "message wrapped");
		assert.equal(lineText(rows[0]).trim(), "");
		assert.equal(lineText(rows[rows.length - 1]).trim(), "");
		const content = rows.slice(1, -1).map(lineText);
		assert.ok(content[0].startsWith("   › "), "first line starts with the prompt");
		for (const line of content.slice(1)) assert.ok(line.startsWith("     "), "continuation aligns after the prompt");
		assert.ok(content.join("").includes("three"));
		assert.ok(content.join("").includes("four"));
	});

	it("长消息可折叠，折叠后只留三行并以省略号收尾", () => {
		const transcript = new Transcript(20);
		transcript.userTurn("one two three four five six seven eight nine ten");

		const expanded = transcript.view();
		const block = expanded.blocks[0];
		assert.ok(block.foldable);

		transcript.toggleFold(block.id);
		const collapsed = transcript.view();
		assert.ok(collapsed.rows.length < expanded.rows.length);
		assert.ok(collapsed.rows.some((row) => lineText(row).includes("…")));
	});
});

describe("块折叠", () => {
	it("工具块收起时只有表头，展开后显示输出", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "tool_start", callId: "1", name: "Read", args: { path: "a.ts" } }, 0);
		transcript.handle({ type: "tool_update", callId: "1", text: "line one\nline two\nline three" }, 1);
		transcript.handle(
			{ type: "tool_end", callId: "1", name: "Read", isError: false, durationMs: 12, summary: "ok" },
			2,
		);

		const collapsed = transcript.view();
		const block = collapsed.blocks.find((item) => item.kind === "tool");
		assert.ok(block?.foldable);

		transcript.toggleFold(block.id);
		const expanded = transcript.view();
		assert.ok(expanded.rows.length > collapsed.rows.length);
		assert.ok(expanded.rows.some((row) => lineText(row).includes("line one")));
	});

	it("思考块默认收起，展开后显示完整草稿", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "reasoning_delta", text: "first thought\nsecond thought" }, 0);
		transcript.handle({ type: "text_delta", text: "answer" }, 10);
		transcript.handle({ type: "run_end" }, 10);

		const collapsed = transcript.view();
		const block = collapsed.blocks.find((item) => item.kind === "thinking");
		assert.ok(block);
		assert.equal(block.mode, "collapsed");
		assert.ok(!collapsed.rows.some((row) => lineText(row).includes("first thought")));

		transcript.toggleFold(block.id);
		const expanded = transcript.view();
		assert.ok(expanded.rows.some((row) => lineText(row).includes("first thought")));
	});

	it("toggleAll 与 toggleAllThinking 按当前状态整体切换", () => {
		const transcript = new Transcript(60);
		transcript.userTurn("hello");
		transcript.handle({ type: "reasoning_delta", text: "thought" }, 0);
		transcript.handle({ type: "text_delta", text: "answer" }, 5);
		transcript.handle({ type: "run_end" }, 5);

		transcript.toggleAll();
		const thinking = transcript.view().blocks.find((item) => item.kind === "thinking");
		assert.equal(thinking?.mode, "expanded");

		transcript.toggleAllThinking();
		const collapsed = transcript.view().blocks.find((item) => item.kind === "thinking");
		assert.equal(collapsed?.mode, "collapsed");
	});

	it("系统块不参与折叠", () => {
		const transcript = new Transcript(40);
		transcript.appendSystem([[{ text: "output" }]]);
		const block = transcript.view().blocks[0];
		assert.equal(block.foldable, false);
	});

	it("blockText 在折叠状态下仍返回完整正文", () => {
		const transcript = new Transcript(20);
		transcript.userTurn("one two three four five six");
		const block = transcript.view().blocks[0];

		transcript.collapse(block.id);
		assert.equal(transcript.blockText(block.id), "one two three four five six");
	});
});
