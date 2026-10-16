import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cellsOf, lineText, plain, styled, type Line } from "../../../src/tui/text/line.ts";
import { displayWidth } from "../../../src/tui/text/width.ts";
import { wrapCells, wrapLine } from "../../../src/tui/text/wrap.ts";

/** 只看文本，不断言样式：绝大多数用例关心的是切在哪里。 */
function texts(lines: readonly Line[]): string[] {
	return lines.map((line) => lineText(line));
}

describe("wrapLine", () => {
	it("放得下就不折行", () => {
		assert.deepEqual(wrapLine(plain("abc def"), { width: 10 }), [plain("abc def")]);
	});

	it("优先在空格处断，断点处的空格留在上一行", () => {
		assert.deepEqual(wrapLine(plain("aa bb cc"), { width: 5 }), [plain("aa "), plain("bb cc")]);
	});

	it("没有空格可断时硬断", () => {
		assert.deepEqual(wrapLine(plain("abcdefgh"), { width: 3 }), [plain("abc"), plain("def"), plain("gh")]);
	});

	it("中文按两列计宽，可以在任意两字之间断开", () => {
		assert.deepEqual(wrapLine(plain("中文换行测试"), { width: 5 }), [
			plain("中文"),
			plain("换行"),
			plain("测试"),
		]);
	});

	it("长单词先塞满再硬断", () => {
		assert.deepEqual(wrapLine(plain("ab ccccccccc"), { width: 4 }), [
			plain("ab "),
			plain("cccc"),
			plain("cccc"),
			plain("c"),
		]);
	});

	it("显式换行一定断行，末尾的换行不多出空行", () => {
		assert.deepEqual(wrapLine(plain("a\nb"), { width: 5 }), [plain("a"), plain("b")]);
		assert.deepEqual(wrapLine(plain("a\n"), { width: 5 }), [plain("a")]);
		assert.deepEqual(wrapLine(plain("a\n\nb"), { width: 5 }), [plain("a"), [], plain("b")]);
		assert.deepEqual(wrapLine(plain(""), { width: 5 }), [[]]);
	});

	it("制表符按八列制表位展开", () => {
		assert.deepEqual(wrapLine(plain("\ta"), { width: 12 }), [plain("        a")]);
		assert.deepEqual(wrapLine(plain("abc\tx"), { width: 12 }), [plain("abc     x")]);
	});

	it("悬挂缩进：首行与折行后的行用各自的前缀", () => {
		const lines = wrapLine(plain("aaaa bbbb cccc"), {
			width: 8,
			firstIndent: plain("· "),
			restIndent: plain("  "),
		});
		assert.deepEqual(texts(lines), ["· aaaa ", "  bbbb ", "  cccc"]);
	});

	it("缩进很宽时至少留出一列内容", () => {
		const lines = wrapLine(plain("abcdef"), { width: 4, firstIndent: plain(">>>>") });
		assert.deepEqual(texts(lines), [">>>>a", "bcde", "f"]);
	});

	it("单字宽于整行时允许该行超出", () => {
		assert.deepEqual(texts(wrapLine(plain("中"), { width: 1 })), ["中"]);
	});

	it("最多行数：超出部分丢掉并补省略号", () => {
		assert.deepEqual(texts(wrapLine(plain("aaaaaaaaaa"), { width: 3, maxLines: 2 })), ["aaa", "aa…"]);
	});

	it("样式在折行处保留", () => {
		assert.deepEqual(wrapLine(styled("abcdef", { dim: true }), { width: 4 }), [
			styled("abcd", { dim: true }),
			styled("ef", { dim: true }),
		]);
	});

	it("宽度或最多行数不合法时抛错", () => {
		assert.throws(() => wrapLine(plain("a"), { width: 0 }), /宽度/);
		assert.throws(() => wrapLine(plain("a"), { width: 3, maxLines: 0 }), /最多行数/);
	});

	it("换行后的每行不超过给定列数（单个宽字符除外）", () => {
		const samples = ["中英混排 wrap 测试，包含标点。", "a very long single token without spaces at all"];
		for (const sample of samples) {
			for (const width of [1, 2, 3, 5, 8, 13, 40]) {
				for (const line of wrapLine(plain(sample), { width })) {
					const limit = Math.max(width, 2);
					assert.ok(
						displayWidth(lineText(line)) <= limit,
						`宽度 ${width} 下产出了过宽的行：${lineText(line)}`,
					);
				}
			}
		}
	});

	it("格子接口给出每行的实际列数", () => {
		const wrapped = wrapCells(cellsOf(plain("接口 api")), { width: 5 });
		// 第一行用满五列：断点上的空格留在上一行，正好占掉最后一列
		assert.deepEqual(
			wrapped.map((line) => line.width),
			[5, 3],
		);
	});
});
