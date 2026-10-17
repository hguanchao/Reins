import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	alignEnds,
	cellIndexAtColumn,
	cellsOf,
	concat,
	lineOfCells,
	lineText,
	lineWidth,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	sameColor,
	sameStyle,
	styled,
	sumCellsWidth,
	type Style,
} from "../../../src/tui/text/line.ts";

const RED: Style = { color: "red" };
const BLUE: Style = { color: "blue" };

describe("行与片段", () => {
	it("空文本产生空行，普通文本产生一个片段", () => {
		assert.deepEqual(plain(""), []);
		assert.deepEqual(plain("hi"), [{ text: "hi" }]);
		assert.deepEqual(styled("", RED), []);
		assert.deepEqual(styled("x", RED), [{ text: "x", style: RED }]);
	});

	it("拼接丢掉空的中间片段", () => {
		assert.deepEqual(concat(plain(""), plain("a"), plain(""), styled("b", RED)), [
			{ text: "a" },
			{ text: "b", style: RED },
		]);
		assert.deepEqual(concat(), []);
	});

	it("宽度按显示宽计算，中文占两列", () => {
		assert.equal(lineWidth(plain("ab中")), 4);
		assert.equal(lineWidth([]), 0);
	});

	it("取纯文本就是各片段拼接", () => {
		assert.equal(lineText(concat(plain("ab"), styled("中", RED))), "ab中");
	});
});

describe("样式合并与比较", () => {
	it("布尔项取并集，颜色内层优先", () => {
		const merged = mergeStyles({ bold: true, color: "red" }, { italic: true, color: "blue" });
		assert.deepEqual(merged, { bold: true, italic: true, color: "blue" });
	});

	it("一边为 undefined 时直接用另一边，undefined 与 undefined 合并还是 undefined", () => {
		assert.equal(mergeStyles(undefined, RED), RED);
		assert.equal(mergeStyles(BLUE, undefined), BLUE);
		assert.equal(mergeStyles(undefined, undefined), undefined);
	});

	it("两项都为否时合并结果不携带任何字段", () => {
		assert.equal(mergeStyles({ bold: false }, { dim: false }), undefined);
	});

	it("背景色同样内层优先", () => {
		const merged = mergeStyles({ background: "red" }, { background: "blue" });
		assert.deepEqual(merged, { background: "blue" });
	});

	it("真彩色逐项比较，字符串不同名即不同", () => {
		assert.equal(sameColor("red", "red"), true);
		assert.equal(sameColor("red", "blue"), false);
		assert.equal(sameColor([1, 2, 3], [1, 2, 3]), true);
		assert.equal(sameColor([1, 2, 3], [1, 2, 4]), false);
		assert.equal(sameColor("red", [255, 0, 0]), false);
		assert.equal(sameColor(undefined, "red"), false);
		assert.equal(sameColor(undefined, undefined), true);
	});

	it("样式比较覆盖所有字段", () => {
		assert.equal(sameStyle(RED, { color: "red" }), true);
		assert.equal(sameStyle(RED, undefined), false);
		assert.equal(sameStyle({ bold: true }, { bold: true }), true);
		assert.equal(sameStyle({ reverse: true }, { reverse: true, bold: true }), false);
		assert.equal(sameStyle({ bold: true }, { color: "red" }), false);
	});
});

describe("改样式与补齐", () => {
	it("mapLine 逐片段换样式", () => {
		const mapped = mapLine(concat(plain("a"), styled("b", RED)), () => BLUE);
		assert.deepEqual(mapped, [
			{ text: "a", style: BLUE },
			{ text: "b", style: BLUE },
		]);
	});

	it("padLine 补到指定宽度，够宽时原样返回", () => {
		const line = plain("ab");
		assert.equal(padLine(line, 2), line);
		assert.equal(lineText(padLine(line, 5)), "ab   ");
		assert.equal(lineWidth(padLine(styled("ab", RED), 5, { bold: true })), 5);
	});

	it("alignEnds 用空格填充中间，放不下时丢弃右段", () => {
		assert.equal(lineText(alignEnds(plain("a"), plain("b"), 5)), "a   b");
		assert.equal(lineText(alignEnds(plain("aaaa"), plain("bbbb"), 5)), "aaaa");
		// gap < 1 就放不下：右段整个消失，左段原样保留
		assert.equal(lineText(alignEnds(plain("a"), plain("b"), 2)), "a");
		assert.equal(lineText(alignEnds(plain("a"), plain("b"), 3)), "a b");
	});
});

describe("格子层投影", () => {
	it("cellsOf 按字素簇摊开且带样式与宽度", () => {
		const cells = cellsOf(concat(plain("ab"), styled("中", RED)));
		assert.equal(cells.length, 3);
		assert.deepEqual(
			cells.map((cell) => cell.width),
			[1, 1, 2],
		);
		assert.equal(cells[0].style, undefined);
		assert.deepEqual(cells[2].style, RED);
	});

	it("lineOfCells 合并相邻同样式的格子", () => {
		const cells = cellsOf(plain("aaa"));
		assert.deepEqual(lineOfCells(cells), [{ text: "aaa" }]);
	});

	it("roundtrip：拼回的行与原行文本相同", () => {
		const line = concat(plain("ab"), styled("中c", RED));
		assert.equal(lineText(lineOfCells(cellsOf(line))), "ab中c");
	});

	it("sumCellsWidth 用建格时算好的宽度", () => {
		assert.equal(sumCellsWidth(cellsOf(plain("ab中"))), 4);
	});

	it("cellIndexAtColumn 按显示列落格，宽字符占两列", () => {
		const line = plain("a中b");
		assert.equal(cellIndexAtColumn(line, 0), 0);
		assert.equal(cellIndexAtColumn(line, 1), 1);
		assert.equal(cellIndexAtColumn(line, 2), 1);
		assert.equal(cellIndexAtColumn(line, 3), 2);
		assert.equal(cellIndexAtColumn(line, 99), 2);
		assert.equal(cellIndexAtColumn(plain(""), 3), 0);
	});
});
