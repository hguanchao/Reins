import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputBoxRows } from "../../../src/plugins/tui-plugin/input-box.ts";
import { lineText } from "../../../src/tui/text/line.ts";
import type { EditorRender } from "../../../src/tui/input/editor.ts";

function editorOf(text: string): EditorRender {
	return { lines: [text.length === 0 ? [] : [{ text }]], cursor: { row: 0, col: text.length }, elements: [] };
}

describe("输入框排版", () => {
	it("上边框、正文行与信息下边框", () => {
		const rows = inputBoxRows({
			width: 40,
			editor: editorOf("hi"),
			focused: true,
			model: "m1",
			approval: "ask",
		});
		assert.equal(rows.length, 4);
		assert.equal(lineText(rows[0]), "");
		assert.equal(lineText(rows[1]), `╭${"─".repeat(38)}╮`);
		const body = lineText(rows[2]);
		assert.ok(body.startsWith("│  hi"));
		assert.ok(body.endsWith("  │"));
		assert.equal(body.length, 40);
		assert.ok(lineText(rows[3]).includes("m1 · approval=ask"));
		assert.ok(lineText(rows[3]).startsWith("╰"));
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
		assert.equal(lineText(rows[3]), `╰${"─".repeat(10)}╯`);
	});
});
