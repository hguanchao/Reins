import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	highlightSelection,
	selectionRange,
	selectionText,
} from "../../../src/plugins/tui-plugin/selection.ts";
import { cellsOf, lineText, plain } from "../../../src/tui/text/line.ts";

describe("文本选区", () => {
	const rows = [plain("hello   "), plain("world"), plain("")];

	it("按端点截取并去掉行尾空白", () => {
		const text = selectionText(rows, {
			anchor: { line: 0, cell: 1 },
			focus: { line: 1, cell: 2 },
		});
		assert.equal(text, "ello\nwor");
	});

	it("反向选择结果相同", () => {
		const forward = selectionText(rows, {
			anchor: { line: 0, cell: 1 },
			focus: { line: 1, cell: 2 },
		});
		const reversed = selectionText(rows, {
			anchor: { line: 1, cell: 2 },
			focus: { line: 0, cell: 1 },
		});
		assert.equal(reversed, forward);
	});

	it("空行保留为空串", () => {
		assert.equal(
			selectionText(rows, {
				anchor: { line: 1, cell: 0 },
				focus: { line: 2, cell: 0 },
			}),
			"world\n",
		);
	});

	it("行内范围夹到有效格子，空行没有范围", () => {
		const selection = {
			anchor: { line: 0, cell: 1 },
			focus: { line: 2, cell: 9 },
		};
		assert.deepEqual(selectionRange(0, selection, rows), { from: 1, to: 7 });
		assert.deepEqual(selectionRange(1, selection, rows), { from: 0, to: 4 });
		assert.equal(selectionRange(2, selection, rows), undefined);
		assert.equal(selectionRange(9, selection, rows), undefined);
	});

	it("高亮只改范围内的格子", () => {
		const line = highlightSelection(plain("abc"), 1, 2, { reverse: true });
		const cells = cellsOf(line);
		assert.equal(cells[0].style, undefined);
		assert.equal(cells[1].style?.reverse, true);
		assert.equal(cells[2].style?.reverse, true);
		assert.equal(lineText(line), "abc");
	});
});
