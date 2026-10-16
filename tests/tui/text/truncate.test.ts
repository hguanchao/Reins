import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cellsOf, plain, styled } from "../../../src/tui/text/line.ts";
import { fitCells, truncateCells, truncateLine } from "../../../src/tui/text/truncate.ts";

describe("truncateLine", () => {
	it("放得下时原样返回", () => {
		assert.deepEqual(truncateLine(plain("abc"), 3), plain("abc"));
		assert.deepEqual(truncateLine(plain("接口"), 4), plain("接口"));
		assert.deepEqual(truncateLine(plain("abc"), 10), plain("abc"));
	});

	it("放不下时补省略号", () => {
		assert.deepEqual(truncateLine(plain("abcdef"), 4), plain("abc…"));
	});

	it("宽度算的是显示列而不是字符数", () => {
		assert.deepEqual(truncateLine(plain("接口abc"), 6), plain("接口a…"));
		// 宽字符放不进去就少放一个，不劈成两半
		assert.deepEqual(truncateLine(plain("接口abc"), 4), plain("接…"));
	});

	it("宽度不足一列时只留省略号", () => {
		assert.deepEqual(truncateLine(plain("abc"), 1), plain("…"));
		assert.deepEqual(truncateLine(plain("abc"), 0), []);
	});

	it("保留样式", () => {
		assert.deepEqual(truncateLine(styled("abcdef", { dim: true }), 3), styled("ab…", { dim: true }));
	});

	it("fitCells 只裁剪不补省略号", () => {
		assert.deepEqual(fitCells(cellsOf(plain("abcdef")), 4), cellsOf(plain("abcd")));
		assert.deepEqual(fitCells(cellsOf(plain("接口a")), 3), cellsOf(plain("接")));
		assert.deepEqual(fitCells(cellsOf(plain("abc")), 0), []);
	});

	it("truncateCells 在刚好等于宽度时不加省略号", () => {
		assert.deepEqual(truncateCells(cellsOf(plain("abcd")), 4), cellsOf(plain("abcd")));
	});
});
