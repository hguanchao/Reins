import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cellsOf, plain, styled } from "../../../src/tui/text/line.ts";
import { ELLIPSIS, fitCells, truncateCells, truncateLine } from "../../../src/tui/text/truncate.ts";

describe("截断", () => {
	it("fitCells 按列裁剪，宽字符放不下就整个丢掉", () => {
		assert.deepEqual(fitCells(cellsOf(plain("abc")), 2).map((cell) => cell.text), ["a", "b"]);
		// 中文一格占两列，宽度 3 只能放下一个字
		assert.deepEqual(fitCells(cellsOf(plain("中文")), 3).map((cell) => cell.text), ["中"]);
		assert.equal(fitCells(cellsOf(plain("abc")), 0).length, 0);
	});

	it("truncateCells 不超宽时原样返回", () => {
		const cells = cellsOf(plain("abc"));
		assert.deepEqual(truncateCells(cells, 3), cells);
		assert.deepEqual(truncateCells(cells, 10), cells);
	});

	it("超宽时补省略号，且省略号沿用末格样式", () => {
		const result = truncateCells(cellsOf(plain("abcdef")), 4);
		assert.deepEqual(result.map((cell) => cell.text), ["a", "b", "c", ELLIPSIS]);

		const styledCells = truncateCells(cellsOf(styled("abcdef", { color: "red" })), 4);
		assert.deepEqual(styledCells[styledCells.length - 1].style, { color: "red" });
	});

	it("输入为空时返回空，宽度为零时也返回空", () => {
		assert.deepEqual(truncateCells(cellsOf(plain("")), 5), []);
		assert.deepEqual(truncateCells(cellsOf(plain("abc")), 0), []);
	});

	it("truncateLine 对整行生效并保留样式", () => {
		const line = truncateLine(styled("abcdef", { color: "red" }), 4);
		// 相邻同样式的格子合并：剩下的字母与省略号同为红色，是一个片段
		assert.deepEqual(line, [{ text: `abc${ELLIPSIS}`, style: { color: "red" } }]);
		assert.deepEqual(truncateLine(plain("hi"), 10), [plain("hi")[0]]);
	});
});
