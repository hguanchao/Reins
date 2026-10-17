import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { drawCopyIcon, drawSelectionBox } from "../../../src/plugins/tui-plugin/conversation-view.ts";
import { lineText, plain } from "../../../src/tui/text/line.ts";

describe("主区装饰", () => {
	it("选中框在块的行范围两侧画竖线", () => {
		const lines = [plain("aa"), plain("bb"), plain("cc")];
		const boxed = drawSelectionBox(lines, { start: 1, height: 1 }, 0, 8).map(lineText);
		assert.equal(boxed[1][1], "│");
		assert.equal(boxed[1][10], "│");
		assert.ok(boxed[1].includes("b"));
	});

	it("复制按钮落在块的第一条非空行", () => {
		const lines = [plain(""), plain("hello"), plain("")];
		const result = drawCopyIcon(lines, { start: 0, height: 3 }, 0, 10, lines);
		assert.deepEqual(result.icon, { line: 1, col: 10 });
		assert.equal(lineText(result.lines[1])[10], "⧉");
	});

	it("块完全滚出视口时原样返回", () => {
		const lines = [plain("aa")];
		const boxed = drawSelectionBox(lines, { start: 5, height: 2 }, 0, 8);
		assert.deepEqual(boxed.map(lineText), ["aa"]);
		const copy = drawCopyIcon(lines, { start: 5, height: 2 }, 0, 8, []);
		assert.equal(copy.icon, undefined);
	});
});
