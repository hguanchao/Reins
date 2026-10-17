import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cellsOf, lineText, plain, styled, type Line } from "../../../src/tui/text/line.ts";
import { wrapCells, wrapLine } from "../../../src/tui/text/wrap.ts";

function texts(lines: readonly Line[]): string[] {
	return lines.map(lineText);
}

describe("换行", () => {
	it("不超宽时一行放下", () => {
		const lines = wrapCells(cellsOf(plain("abc")), { width: 10 });
		assert.equal(lines.length, 1);
		assert.equal(lines[0].sourceStart, 0);
		assert.equal(lineText(lines[0].cells), "abc");
	});

	it("优先在空格处断，空格留在上一行", () => {
		assert.deepEqual(wrapCells(cellsOf(plain("ab cd ef")), { width: 5 }).map((l) => lineText(l.cells)), [
			"ab ",
			"cd ef",
		]);
	});

	it("没有空格可断时硬断长单词", () => {
		const lines = wrapCells(cellsOf(plain("aaaaaa")), { width: 4 });
		assert.deepEqual(lines.map((line) => lineText(line.cells)), ["aaaa", "aa"]);
	});

	it("中文可以任意两字之间断开", () => {
		const lines = wrapCells(cellsOf(plain("一二三四五")), { width: 4 });
		assert.deepEqual(lines.map((line) => lineText(line.cells)), ["一二", "三四", "五"]);
	});

	it("换行符强制断行，末尾换行不产生空行", () => {
		assert.deepEqual(wrapCells(cellsOf(plain("a\nb")), { width: 10 }).map((l) => lineText(l.cells)), ["a", "b"]);
		assert.deepEqual(wrapCells(cellsOf(plain("a\n")), { width: 10 }).map((l) => lineText(l.cells)), ["a"]);
	});

	it("空输入仍返回一行", () => {
		const lines = wrapCells([], { width: 10 });
		assert.equal(lines.length, 1);
		assert.equal(lines[0].cells.length, 0);
	});

	it("支持 CRLF 与 CR", () => {
		assert.deepEqual(wrapCells(cellsOf(plain("a\r\nb\rc")), { width: 10 }).map((l) => lineText(l.cells)), ["a", "b", "c"]);
	});

	it("制表符展开到 8 列制表位", () => {
		assert.deepEqual(wrapCells(cellsOf(plain("ab\tc")), { width: 20 }).map((l) => lineText(l.cells)), ["ab      c"]);
	});

	it("行首缩进不会被单独留在一行", () => {
		const lines = wrapCells(cellsOf(plain("ab")), { width: 2, restIndent: plain("· ") });
		assert.deepEqual(lines.map((l) => lineText(l.cells)), ["ab"]);
	});

	it("折行后的续行带 restIndent", () => {
		const lines = wrapCells(cellsOf(plain("abc def")), { width: 6, restIndent: plain("  ") });
		assert.deepEqual(lines.map((l) => lineText(l.cells)), ["abc ", "  def"]);
	});

	it("firstIndent 与 restIndent 可以不同", () => {
		const lines = wrapCells(cellsOf(plain("abc def")), { width: 6, firstIndent: plain("> "), restIndent: plain("  ") });
		assert.deepEqual(lines.map((l) => lineText(l.cells)), ["> abc ", "  def"]);
	});

	it("sourceStart 把输出行映射回输入格子", () => {
		const cells = cellsOf(plain("ab cd"));
		const lines = wrapCells(cells, { width: 5 });
		// "ab cd" 全行放下；再来看折断的情形
		const broken = wrapCells(cellsOf(plain("abcd efgh")), { width: 5 });
		assert.deepEqual(broken.map((line) => line.sourceStart), [0, 5]);
		assert.ok(lines[0].sourceStart === 0);
	});

	it("超出行数上限时在末行截短并加省略号", () => {
		// 硬断产生 4 行，只保留 3 行，末行截到宽度减一列再补省略号
		const lines = wrapCells(cellsOf(plain("x".repeat(40))), { width: 10, maxLines: 3 });
		assert.equal(lines.length, 3);
		assert.deepEqual(lines.map((l) => lineText(l.cells)), ["xxxxxxxxxx", "xxxxxxxxxx", "xxxxxxxxx…"]);
	});

	it("宽度非法时报错而不是静默", () => {
		assert.throws(() => wrapCells([], { width: 0 }), /Wrap width/);
		assert.throws(() => wrapCells([], { width: 1.5 }), /positive integer/);
		assert.throws(() => wrapCells([], { width: 10, maxLines: 0 }), /Max lines/);
	});

	it("单字宽于整行时允许超出宽度（唯一情形）", () => {
		// 宽度 1 连一个 2 列的中文都放不下，只能整字成行，宽度超出
		const lines = wrapCells(cellsOf(plain("中")), { width: 1 });
		assert.equal(lines.length, 1);
		assert.equal(lines[0].width, 2);
	});

	it("wrapLine 返回普通片段行，样式保留", () => {
		const lines = wrapLine(styled("一二三四五六", { color: "red" }), { width: 4 });
		assert.deepEqual(texts(lines), ["一二", "三四", "五六"]);
		assert.deepEqual(lines[0][0].style, { color: "red" });
	});
});
