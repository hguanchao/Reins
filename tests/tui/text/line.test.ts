import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	alignEnds,
	concat,
	lineOfCells,
	lineText,
	lineWidth,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	sameStyle,
	styled,
} from "../../../src/tui/text/line.ts";

describe("line", () => {
	it("空文本产生空行", () => {
		assert.deepEqual(plain(""), []);
		assert.deepEqual(styled("", { bold: true }), []);
	});

	it("宽度按显示宽度算", () => {
		assert.equal(lineWidth(plain("接口 api")), 8);
		assert.equal(lineWidth(concat(plain("接口"), styled(" api", { dim: true }))), 8);
	});

	it("拼接时丢掉空片段", () => {
		assert.deepEqual(concat(plain(""), plain("a"), plain("")), [{ text: "a" }]);
	});

	it("取纯文本", () => {
		assert.equal(lineText(concat(plain("a"), styled("中", { bold: true }))), "a中");
	});

	it("样式并集，颜色以更具体的一侧为准", () => {
		assert.deepEqual(mergeStyles({ bold: true }, { dim: true, color: "cyan" }), {
			bold: true,
			dim: true,
			color: "cyan",
		});
		assert.equal(mergeStyles({ color: "red" }, { color: "green" })?.color, "green");
		assert.equal(mergeStyles(undefined, { dim: true })?.dim, true);
		assert.equal(mergeStyles({ dim: true }, undefined)?.dim, true);
		// 什么都没设就是没有样式，避免产生一个空壳样式让相邻片段没法合并
		assert.equal(mergeStyles({}, {}), undefined);
	});

	it("逐片段改样式", () => {
		const line = mapLine(concat(plain("a"), styled("b", { bold: true })), (style) =>
			mergeStyles(style, { dim: true }),
		);
		assert.deepEqual(line, [
			{ text: "a", style: { dim: true } },
			{ text: "b", style: { bold: true, dim: true } },
		]);
	});

	it("按宽度补齐行尾", () => {
		assert.equal(lineWidth(padLine(plain("接口"), 8)), 8);
		assert.deepEqual(padLine(plain("12345"), 3), plain("12345"));
	});

	it("格子拼回片段时合并相邻同样式部分", () => {
		const cells = [
			{ text: "接", width: 2 },
			{ text: "口", width: 2 },
			{ text: " ", width: 1, style: { dim: true } },
			{ text: "a", width: 1, style: { dim: true } },
		];
		assert.deepEqual(lineOfCells(cells), [{ text: "接口" }, { text: " a", style: { dim: true } }]);
	});
});

describe("行与样式", () => {
	it("合并样式时背景也取内层，逐项都留下", () => {
		const merged = mergeStyles({ bold: true, background: [1, 2, 3] }, { background: [4, 5, 6], color: "red" });
		assert.deepEqual(merged, { bold: true, background: [4, 5, 6], color: "red" });
	});

	it("真彩色按值比较，不比引用", () => {
		assert.equal(sameStyle({ color: [1, 2, 3] }, { color: [1, 2, 3] }), true);
		assert.equal(sameStyle({ color: [1, 2, 3] }, { color: [1, 2, 4] }), false);
		assert.equal(sameStyle({ background: [1, 2, 3] }, { background: [1, 2, 3] }), true);
	});

	it("补齐时能带上样式：整行铺底靠它", () => {
		const filled = padLine(plain("ab"), 5, { background: [9, 9, 9] });
		assert.equal(lineWidth(filled), 5);
		assert.deepEqual(filled[1], { text: "   ", style: { background: [9, 9, 9] } });
		// 已经够宽就原样返回
		assert.deepEqual(padLine(plain("abcdef"), 3), plain("abcdef"));
	});

	it("左右两段撑满一行，放不下时让右边整个消失", () => {
		assert.equal(lineText(alignEnds(plain("a"), plain("b"), 5)), "a   b");
		// 至少要留一个空格把两段分开，否则右边的整段消失
		assert.equal(lineText(alignEnds(plain("aaaa"), plain("bb"), 7)), "aaaa bb");
		assert.equal(lineText(alignEnds(plain("aaaa"), plain("bb"), 6)), "aaaa");
		assert.equal(lineText(alignEnds(plain("aaaaa"), plain("bb"), 5)), "aaaaa");
	});
});
