import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { viewerRows } from "../../../src/plugins/tui-plugin/viewer.ts";
import { lineText } from "../../../src/tui/text/line.ts";

describe("块查看器", () => {
	it("带标题的边框包住内容，并占满给定行数", () => {
		const view = viewerRows({
			width: 60,
			rows: 8,
			title: "Output · Read a.ts",
			text: "one\ntwo\nthree",
			scroll: 0,
		});
		const text = view.lines.map(lineText);
		assert.equal(view.lines.length, 8);
		assert.ok(text[0].includes("╭") && text[0].includes("Output · Read a.ts"), text[0]);
		assert.ok(text.some((line) => line.includes("one")));
		assert.ok(text.some((line) => line.includes("two")));
		assert.ok(text.some((line) => line.includes("three")));
		assert.equal(view.maxScroll, 0);
	});

	it("长内容可滚动，标题带上位置", () => {
		const body = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
		const view = viewerRows({ width: 60, rows: 8, title: "Answer", text: body, scroll: 2 });
		const text = view.lines.map(lineText);
		assert.equal(view.maxScroll, 30 - 6);
		assert.ok(text[0].includes("3-8/30"), text[0]);
		assert.ok(text.some((line) => line.includes("line 3")));
		assert.ok(!text.some((line) => line.includes("line 1 ")));
	});

	it("滚动位置越界时夹到末尾", () => {
		const body = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
		const view = viewerRows({ width: 60, rows: 8, title: "Answer", text: body, scroll: 999 });
		const text = view.lines.map(lineText).join("\n");
		assert.ok(text.includes("line 30"));
	});

	it("矮屏不画边框，也不丢内容", () => {
		const view = viewerRows({ width: 40, rows: 3, title: "Answer", text: "one\ntwo\nthree", scroll: 0 });
		assert.equal(view.lines.length, 3);
		assert.ok(!view.lines.some((line) => lineText(line).includes("╭")));
		assert.ok(view.lines.some((line) => lineText(line).includes("one")));
	});

	it("清掉工具输出里的颜色转义", () => {
		const view = viewerRows({ width: 60, rows: 6, title: "Output", text: "\x1b[31mred\x1b[0m", scroll: 0 });
		const text = view.lines.map(lineText).join("\n");
		assert.ok(text.includes("red"));
		assert.ok(!text.includes("\x1b"));
	});
});
