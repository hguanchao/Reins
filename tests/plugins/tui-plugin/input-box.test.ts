import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputBoxRows, INPUT_LEFT } from "../../../src/plugins/tui-plugin/input-box.ts";
import { lineText } from "../../../src/tui/text/line.ts";
import type { EditorRender } from "../../../src/tui/input/editor.ts";

function editorOf(text: string): EditorRender {
	return { lines: [text.length === 0 ? [] : [{ text }]], cursor: { row: 0, col: text.length }, elements: [] };
}

describe("输入框排版", () => {
	it("两侧缩进外边距，正文行与信息下边框都在框里", () => {
		const rows = inputBoxRows({
			width: 40,
			editor: editorOf("hi"),
			focused: true,
			model: "m1",
			approval: "ask",
		});
		assert.equal(rows.length, 4);
		assert.equal(lineText(rows[0]), "");
		// 框体 36 列，前面补 2 列外边距
		assert.equal(lineText(rows[1]), `  ╭${"─".repeat(34)}╮`);
		const body = lineText(rows[2]);
		assert.ok(body.startsWith("  │  hi"));
		assert.ok(body.trimEnd().endsWith("│"));
		// 框体 36 列加 2 列左边距；右外边距由整屏底色补齐
		assert.equal(body.length, 38);
		const info = lineText(rows[3]);
		assert.ok(info.includes("m1 · approval=ask"));
		assert.ok(info.trim().startsWith("╰"));
	});

	it("光标列常量与外边距同步", () => {
		// 左边距(2) + 左边框(1) + 左留白(2)
		assert.equal(INPUT_LEFT, 5);
	});

	it("失焦时正文压暗", () => {
		const rows = inputBoxRows({
			width: 30,
			editor: editorOf("hi"),
			focused: false,
			model: "m1",
			approval: "ask",
		});
		const hi = rows[2].find((span) => span.text.includes("hi"));
		assert.equal(hi?.style?.dim, true);
	});

	it("窄到放不下时不嵌信息", () => {
		const rows = inputBoxRows({
			width: 12,
			editor: editorOf(""),
			focused: true,
			model: "a-very-long-model-name",
			approval: "ask",
		});
		assert.equal(lineText(rows[3]).trim(), `╰${"─".repeat(6)}╯`);
	});
});
