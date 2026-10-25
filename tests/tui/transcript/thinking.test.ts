import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEME } from "../../../src/tui/theme.ts";
import { renderTranscript, thinkingHeaderAtRow } from "../../../src/tui/transcript.ts";
import type { TranscriptThinking, TranscriptTurn } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("思考区块", () => {
	function blockOf(header: string, running: boolean): TranscriptThinking {
		return {
			kind: "thinkingBlock",
			header,
			body: ["one", "two", "three", "four", "five", "six", "seven"],
			partial: "",
			running,
			expanded: false,
		};
	}

	it("运行中只显示最后五行，结束后收起，展开显示全文", () => {
		const block = blockOf("Thinking…", true);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };

		let text = renderTranscript(40, 12, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("  ✻ Thinking…"));
		assert.ok(
			["three", "four", "five", "six", "seven"].every((line) => text.includes(line)),
		);
		assert.equal(text.includes("one"), false);
		assert.equal(text.includes("two"), false);

		block.expanded = true;
		text = renderTranscript(40, 20, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("one"));

		block.running = false;
		block.expanded = false;
		block.header = "Thought for 1.0s";
		text = renderTranscript(40, 12, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("  ✻ Thought for 1.0s"));
		assert.equal(text.includes("seven"), false);

		block.expanded = true;
		text = renderTranscript(40, 20, [turn], 0).map(plain).join("\n");
		assert.ok(text.includes("one") && text.includes("seven"));
	});

	it("正文缩进到标题首字，色带外留四列", () => {
		const block = blockOf("Thinking…", true);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };
		const lines = renderTranscript(40, 12, [turn], 0);

		const header = lines.find((line) => plain(line).includes("Thinking…"));
		const body = lines.find((line) => plain(line).includes("three"));
		assert.ok(header);
		assert.ok(body);
		assert.ok(plain(header).startsWith("  ✻ Thinking…"));
		assert.ok(plain(body).startsWith("     three"));
		assert.equal(header.includes(THEME.surface), false);
		assert.equal(body.indexOf(THEME.surface), 4);
	});

	it("展开时只提亮标题标签，耗时保持弱化", () => {
		const block = blockOf("Thought for 1.0s", false);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };

		let header = renderTranscript(40, 12, [turn], 0).find((line) =>
			plain(line).includes("Thought for 1.0s"),
		);
		assert.ok(header?.includes(THEME.textSubtle));
		assert.equal(header?.includes(THEME.textPrimary), false);

		block.expanded = true;
		header = renderTranscript(40, 12, [turn], 0).find((line) =>
			plain(line).includes("Thought for 1.0s"),
		);
		assert.ok(header?.includes(`${THEME.textPrimary}  ◈ Thought for ${THEME.textSubtle}1.0s`));
		assert.equal(header?.includes(THEME.accent), false);
	});

	it("思考正文上下各留一行色带，展开标记换成菱形", () => {
		const block = blockOf("Thought for 1.0s", false);
		block.expanded = true;
		const lines = renderTranscript(40, 20, [{ prompt: "hi", response: [block] }], 0);
		const headerRow = lines.findIndex((line) => plain(line).includes("◈ Thought for"));
		assert.ok(headerRow >= 0);

		const top = lines[headerRow + 1] ?? "";
		assert.ok(top.includes(THEME.surface));
		assert.equal(plain(top).trim(), "");

		const first = lines[headerRow + 2] ?? "";
		assert.ok(first.includes(THEME.surface));
		assert.equal(plain(first).trim(), "one");

		const body = lines.find((line) => plain(line).includes("three")) ?? "";
		assert.ok(body.startsWith(`    ${THEME.surface}`));
		assert.ok(plain(body).startsWith("     three"));

		const lastRow = lines.findIndex((line) => plain(line).includes("seven"));
		assert.ok(lastRow >= 0);
		const bottom = lines[lastRow + 1] ?? "";
		assert.ok(bottom.includes(THEME.surface));
		assert.equal(plain(bottom).trim(), "");
	});

	it("标题行可以命中，正文行不能", () => {
		const block = blockOf("Thought for 1.0s", false);
		const turn: TranscriptTurn = { prompt: "hi", response: [block] };
		const row =
			renderTranscript(40, 12, [turn], 0).map(plain).findIndex((line) => line.includes("Thought for 1.0s")) + 1;

		assert.equal(thinkingHeaderAtRow(40, 12, [turn], 0, row), block);
		assert.equal(thinkingHeaderAtRow(40, 12, [turn], 0, row + 1), undefined);
	});
});
