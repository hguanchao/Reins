import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputBoxRows, INPUT_LEFT } from "../../../src/plugins/tui-plugin/input-box.ts";
import { THEME } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText } from "../../../src/tui/text/line.ts";
import type { EditorRender } from "../../../src/tui/input/editor.ts";

function editorOf(text: string): EditorRender {
	return { lines: [text.length === 0 ? [] : [{ text }]], cursor: { row: 0, col: text.length }, elements: [] };
}

describe("输入框排版", () => {
	it("两侧缩进外边距，提示符与左边框直接相贴", () => {
		const rows = inputBoxRows({
			width: 40,
			editor: editorOf("hi"),
			focused: true,
			model: "m1",
			approval: "ask",
		});
		// 上边框、正文、信息下边框；与画面之间没有空行
		assert.equal(rows.length, 3);
		// 框体 36 列，前面补 2 列外边距
		assert.equal(lineText(rows[0]), `  ╭${"─".repeat(34)}╮`);
		const body = lineText(rows[1]);
		assert.ok(body.startsWith("  │hi"), "no indent cell before the text");
		assert.ok(body.trimEnd().endsWith("│"));
		// 框体 36 列加 2 列左边距；右外边距由整屏底色补齐
		assert.equal(body.length, 38);
		const info = lineText(rows[2]);
		assert.ok(info.includes("m1 · ask"));
		assert.ok(info.trim().startsWith("╰"));
	});

	it("光标列常量与外边距同步", () => {
		// 左边距(2) + 左边框(1)
		assert.equal(INPUT_LEFT, 3);
	});

	it("失焦时正文压暗", () => {
		const rows = inputBoxRows({
			width: 30,
			editor: editorOf("hi"),
			focused: false,
			model: "m1",
			approval: "ask",
		});
		const hi = rows[1].find((span) => span.text.includes("hi"));
		assert.equal(hi?.style?.dim, true);
	});

	it("草稿里有换行时在右下角标出 multiline", () => {
		const rows = inputBoxRows({
			width: 40,
			editor: editorOf("hi"),
			focused: true,
			model: "m1",
			approval: "ask",
			multiline: true,
		});
		assert.ok(lineText(rows[2]).includes("m1 · ask  multiline"));
	});

	it("草稿超过可见行数时在右侧内边距里画滚动条", () => {
		const editor: EditorRender = {
			lines: [[{ text: "one" }], [{ text: "two" }], [{ text: "three" }]],
			cursor: { row: 2, col: 5 },
			elements: [],
			scroll: { start: 0, total: 9 },
		};
		const rows = inputBoxRows({
			width: 40,
			editor,
			focused: true,
			model: "m1",
			approval: "ask",
		});
		assert.ok(lineText(rows[1]).includes("█"), "thumb in the padding column");
		assert.ok(
			rows[1].some(
				(span) => span.style?.background === THEME.scrollTrack || span.text === "█",
			),
		);
		for (const row of rows.slice(1, 4)) assert.equal(lineText(row).length, 38);
	});

	it("顶边框右侧可以嵌暂存标题", () => {
		const rows = inputBoxRows({
			width: 40,
			editor: editorOf(""),
			focused: true,
			model: "m1",
			approval: "ask",
			caption: "Stashed",
		});
		const top = lineText(rows[0]);
		assert.ok(top.includes("Stashed"), top);
		assert.ok(top.trimEnd().endsWith("╮"), top);
		assert.equal(top.trim().length, 36);
	});

	it("窄到放不下时不嵌信息", () => {
		const rows = inputBoxRows({
			width: 12,
			editor: editorOf(""),
			focused: true,
			model: "a-very-long-model-name",
			approval: "ask",
		});
		assert.equal(lineText(rows[2]).trim(), `╰${"─".repeat(6)}╯`);
	});
});
