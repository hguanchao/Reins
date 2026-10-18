import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Transcript } from "../../../src/plugins/tui-plugin/transcript.ts";
import { THEME } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("用户消息", () => {
	it("单行消息占三行，正文在中间并带时间戳", () => {
		const transcript = new Transcript(40);
		transcript.userTurn("hello", 0);
		const rows = transcript.view().rows;

		assert.equal(rows.length, 3);
		const text = lineText(rows[1]);
		assert.ok(text.startsWith("❯ hello"));
		assert.match(text, /\d{1,2}:\d{2} (AM|PM)/);
		assert.equal(lineWidth(rows[1]), 40);
		assert.equal(lineText(rows[0]).trim(), "");
		assert.equal(lineText(rows[2]).trim(), "");
	});

	it("记录时间戳位置与原始时刻", () => {
		const transcript = new Transcript(40);
		const createdAt = new Date(2026, 9, 17, 14, 33).getTime();
		transcript.userTurn("hello", createdAt);
		const view = transcript.view();
		assert.equal(view.timestamps.length, 1);
		assert.equal(view.timestamps[0].createdAt, createdAt);
		assert.equal(view.timestamps[0].row, 1);
		assert.ok(view.timestamps[0].col > 0);
		assert.match(lineText(view.rows[view.timestamps[0].row]), /\d{1,2}:\d{2} (AM|PM)/);
	});

	it("回合预览取用户消息的第一行", () => {
		const transcript = new Transcript(40);
		transcript.userTurn("hello\nworld");
		transcript.userTurn("second");
		const view = transcript.view();
		assert.deepEqual(view.turnPreviews, ["hello", "second"]);
		assert.equal(view.turns.length, view.turnPreviews.length);
	});

	it("带 ❯ 前缀，正文从块的竖线列之后开始", () => {
		const transcript = new Transcript(40);
		transcript.userTurn("hello");
		const rows = transcript.view().rows;

		assert.ok(lineText(rows[1]).startsWith("❯ hello"));
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
		const transcript = new Transcript(25);
		transcript.userTurn("one two three four", 0);

		const rows = transcript.view().rows;
		assert.ok(rows.length > 3, "message wrapped");
		assert.equal(lineText(rows[0]).trim(), "");
		assert.equal(lineText(rows[rows.length - 1]).trim(), "");
		const content = rows.slice(1, -1).map(lineText);
		assert.ok(content[0].startsWith("❯ "), "first line starts with the prompt");
		for (const line of content.slice(1)) assert.ok(line.startsWith("  "), "continuation aligns after the prompt");
		assert.ok(content.join("").includes("three"));
		assert.ok(content.join("").includes("four"));
	});

	it("模型回答的第一行也带时间戳", () => {
		const transcript = new Transcript(40);
		transcript.handle({ type: "text_delta", text: "answer" }, 0);
		transcript.handle({ type: "run_end" }, 0);

		const row = transcript.view().rows.find((line) => lineText(line).includes("answer"));
		assert.ok(row);
		assert.match(lineText(row), /\d{1,2}:\d{2} (AM|PM)/);
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

	it("代码块下面的复制操作行带正确的行号与列范围", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "text_delta", text: "```bash\necho hi\n```" }, 0);
		transcript.handle({ type: "run_end" }, 1);

		const view = transcript.view();
		assert.equal(view.copies.length, 1);
		const copy = view.copies[0];
		assert.equal(copy.content, "echo hi");
		const row = view.rows[copy.row];
		assert.ok(row, "copy row points at a real row");
		// 列是正文相对坐标：组合行还带着块左边 3 列的竖线与留白
		assert.equal(lineText(row).slice(copy.from + 3, copy.to + 3), "[Copy]");
	});
});

describe("块折叠", () => {
	it("工具块汇总成组头，展开后显示输出", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "tool_start", callId: "1", name: "Read", args: { path: "a.ts" } }, 0);
		transcript.handle({ type: "tool_update", callId: "1", text: "line one\nline two\nline three" }, 1);
		transcript.handle(
			{ type: "tool_end", callId: "1", name: "Read", isError: false, durationMs: 12, summary: "ok" },
			2,
		);

		const collapsed = transcript.view();
		const block = collapsed.blocks.find((item) => item.kind === "group");
		assert.ok(block?.foldable);
		assert.ok(collapsed.rows.some((row) => lineText(row).includes("Read 1 file")));

		transcript.toggleFold(block.id);
		const expanded = transcript.view();
		assert.ok(expanded.rows.some((row) => lineText(row).includes("Read  a.ts")));

		const member = expanded.blocks.find((item) => item.kind === "tool");
		assert.ok(member);
		transcript.toggleFold(member.id);
		const detail = transcript.view();
		assert.ok(detail.rows.some((row) => lineText(row).includes("line one")));
	});

	it("连续同类工具按动词汇总，失败数单独标出", () => {
		const transcript = new Transcript(60);
		const end = (callId: string, name: string, isError = false): void => {
			transcript.handle(
				{ type: "tool_end", callId, name, isError, durationMs: 1, summary: "done" },
				0,
			);
		};

		transcript.handle({ type: "tool_start", callId: "1", name: "Read", args: { path: "a" } }, 0);
		end("1", "Read");
		transcript.handle({ type: "tool_start", callId: "2", name: "Read", args: { path: "b" } }, 0);
		end("2", "Read", true);
		transcript.handle({ type: "tool_start", callId: "3", name: "grep", args: { pattern: "x" } }, 0);
		end("3", "grep");

		const view = transcript.view();
		const block = view.blocks.find((item) => item.kind === "group");
		assert.ok(block);
		const header = lineText(view.rows[block.start]);
		assert.ok(header.includes("◆ Read 2 files"), header);
		assert.ok(header.includes("Searched 1 pattern"), header);
		assert.ok(header.includes("1 failed"), header);
	});

	it("目录与读取混在一组时合并成 Explored", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "tool_start", callId: "1", name: "ls", args: { path: "." } }, 0);
		transcript.handle({ type: "tool_end", callId: "1", name: "ls", isError: false, durationMs: 1, summary: "ok" }, 0);
		transcript.handle({ type: "tool_start", callId: "2", name: "Read", args: { path: "a" } }, 0);
		transcript.handle({ type: "tool_end", callId: "2", name: "Read", isError: false, durationMs: 1, summary: "ok" }, 0);
		transcript.handle({ type: "tool_start", callId: "3", name: "Read", args: { path: "b" } }, 0);
		transcript.handle({ type: "tool_end", callId: "3", name: "Read", isError: false, durationMs: 1, summary: "ok" }, 0);

		const view = transcript.view();
		const block = view.blocks.find((item) => item.kind === "group");
		assert.ok(block);
		assert.ok(lineText(view.rows[block.start]).includes("Explored 1 directory, 2 files"));
	});

	it("运行中的连续工具用进行时汇总成一行", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "tool_start", callId: "1", name: "Read", args: { path: "a.ts" } }, 0);
		transcript.handle({ type: "tool_start", callId: "2", name: "Read", args: { path: "b.ts" } }, 0);
		transcript.handle({ type: "tool_start", callId: "3", name: "grep", args: { pattern: "x" } }, 0);

		const rows = transcript.view({ now: 0 }).rows.map(lineText);
		const header = rows.find((line) => line.includes("Reading"));
		assert.ok(header, "running group header");
		assert.ok(header.includes("Searching 1 pattern"), header);
		assert.ok(!rows.some((line) => line.includes("a.ts")), "per-call paths stay hidden while grouped");
	});

	it("工具参数显示为相对路径和偏移量，不打印 JSON", () => {
		const transcript = new Transcript(60);
		transcript.setCwd("E:/w");
		transcript.handle(
			{
				type: "tool_start",
				callId: "1",
				name: "read",
				args: { path: "E:\\w\\src\\a.ts", offset: 10, limit: 5 },
			},
			0,
		);
		transcript.handle(
			{ type: "tool_end", callId: "1", name: "read", isError: false, durationMs: 1, summary: "ok" },
			0,
		);

		const group = transcript.view().blocks.find((item) => item.kind === "group");
		assert.ok(group);
		transcript.toggleFold(group.id);
		const member = transcript.view().rows.find((row) => lineText(row).includes("Read  "));
		assert.ok(member);
		assert.ok(lineText(member).includes("Read  src/a.ts (10–15)"));
		assert.ok(!lineText(member).includes("{"));
	});

	it("展开的读取详情：行号从工具头那一列开始，正文按文件类型着色", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "tool_start", callId: "1", name: "read", args: { path: "a.ts" } }, 0);
		transcript.handle(
			{
				type: "tool_end",
				callId: "1",
				name: "read",
				isError: false,
				durationMs: 1,
				summary: "ok",
				content: 'const n = "x";\nlet m = 2;',
			},
			0,
		);

		const group = transcript.view().blocks.find((item) => item.kind === "group");
		assert.ok(group);
		transcript.toggleFold(group.id);
		const member = transcript.view().blocks.find((item) => item.kind === "tool");
		assert.ok(member);
		transcript.toggleFold(member.id);

		const view = transcript.view();
		const header = view.rows[member.start];
		const first = view.rows[member.start + 1];
		const second = view.rows[member.start + 2];
		assert.ok(header && first && second);
		// 行号列与工具头的符号同列，不再是贴着块的左缘
		assert.equal(lineText(header).indexOf("◆"), 3);
		assert.equal(lineText(first).indexOf("1"), 3);
		assert.ok(lineText(first).startsWith("   1  "), lineText(first));
		assert.ok(lineText(second).startsWith("   2  "), lineText(second));
		// 行号留在代码底色之外，正文一整行铺底，整块才连成一片
		assert.equal(first[0]?.style?.background, undefined);
		assert.equal(lineText(first).slice(0, 3), "   ");
		// 正文按 ts 着色：关键字拿到强调色，不再是一整行的灰
		assert.equal(first.find((span) => span.text.includes("const"))?.style?.color, THEME.accent);
		assert.equal(second.at(-1)?.style?.background, THEME.codeBg);
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
		assert.ok(
			collapsed.rows.some((row) => lineText(row).includes("(ctrl+e to expand)")),
			"collapsed thinking advertises the expand key",
		);

		const narrow = new Transcript(20);
		narrow.handle({ type: "reasoning_delta", text: "first thought" }, 0);
		narrow.handle({ type: "text_delta", text: "answer" }, 10);
		narrow.handle({ type: "run_end" }, 10);
		assert.ok(
			!narrow.view().rows.some((row) => lineText(row).includes("ctrl+e to expand")),
			"hint is omitted when it does not fit",
		);

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

	it("工具完成后的展开块会短暂闪绿", () => {
		const transcript = new Transcript(60);
		transcript.handle({ type: "tool_start", callId: "1", name: "Read", args: { path: "a" } }, 0);
		transcript.handle(
			{ type: "tool_end", callId: "1", name: "Read", isError: false, durationMs: 1, summary: "ok" },
			400,
		);

		const collapsed = transcript.view({ now: 500 });
		const group = collapsed.blocks.find((item) => item.kind === "group");
		assert.ok(group);
		transcript.toggleFold(group.id);
		const member = transcript.view({ now: 500 }).blocks.find((item) => item.kind === "tool");
		assert.ok(member);
		transcript.toggleFold(member.id);

		const flashing = transcript.view({ now: 500 }).rows;
		const flashingHeader = flashing[group.start + 1];
		assert.equal(flashingHeader?.[0]?.text, "┃");
		assert.equal(flashingHeader?.[0]?.style?.color, THEME.ok);

		const settled = transcript.view({ now: 900 }).rows;
		assert.equal(settled[group.start + 1]?.[0]?.style?.color, THEME.faint);
	});

	it("blockText 在折叠状态下仍返回完整正文", () => {
		const transcript = new Transcript(20);
		transcript.userTurn("one two three four five six");
		const block = transcript.view().blocks[0];

		transcript.collapse(block.id);
		assert.equal(transcript.blockText(block.id), "one two three four five six");
	});

	it("blockMeta 返回工具调用，汇总组按成员逐条返回", () => {
		const transcript = new Transcript(80);
		transcript.handle({ type: "tool_start", callId: "1", name: "Read", args: { path: "a.ts" } }, 0);
		transcript.handle(
			{ type: "tool_end", callId: "1", name: "Read", isError: false, durationMs: 1, summary: "ok" },
			1,
		);
		transcript.handle({ type: "tool_start", callId: "2", name: "grep", args: { pattern: "needle" } }, 2);
		transcript.handle(
			{ type: "tool_end", callId: "2", name: "grep", isError: false, durationMs: 1, summary: "ok" },
			3,
		);

		const group = transcript.view().blocks[0];
		assert.equal(transcript.blockMeta(group.id), "Read a.ts\n\ngrep \"needle\"");

		const user = new Transcript(20);
		user.userTurn("hi");
		assert.equal(user.blockMeta(user.view().blocks[0].id), undefined);
	});
});
