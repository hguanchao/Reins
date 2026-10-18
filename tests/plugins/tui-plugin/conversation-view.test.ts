import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	drawHoverCard,
	drawSelectionBand,
	drawSelectionBox,
	expandTimestamp,
} from "../../../src/plugins/tui-plugin/conversation-view.ts";
import { lineText, plain } from "../../../src/tui/text/line.ts";

describe("主区装饰", () => {
	it("选中框在块的行范围两侧画竖线", () => {
		const lines = [plain("aa"), plain("bb"), plain("cc")];
		const boxed = drawSelectionBox(lines, { start: 1, height: 1 }, 0, 8).map(lineText);
		assert.equal(boxed[1][1], "│");
		assert.equal(boxed[1][10], "│");
		assert.ok(boxed[1].includes("b"));
	});

	it("展开的选中块也画满两侧竖线，框不缺口", () => {
		const lines = Array.from({ length: 6 }, (_, index) => plain(`row${index}`));
		const boxed = drawSelectionBox(lines, { start: 1, height: 4 }, 0, 8).map(lineText);
		for (const row of boxed.slice(1, 5)) {
			assert.equal(row[1], "│", `块内两侧竖线: ${row}`);
			assert.equal(row[10], "│", `块内两侧竖线: ${row}`);
		}
		assert.equal(boxed[0][1], "┌");
		assert.equal(boxed[0][10], "┐");
		assert.equal(boxed[5][1], "└");
		assert.equal(boxed[5][10], "┘");
	});

	it("块完全滚出视口时原样返回", () => {
		const lines = [plain("aa")];
		const boxed = drawSelectionBand(lines, { start: 5, height: 1 }, 0, 8);
		assert.deepEqual(boxed.map(lineText), ["aa"]);
	});

	it("选中的收起行铺高亮底色，菱形换成 ▸ 护栏", () => {
		const lines = [plain("   ◆ List  src"), plain("other")];
		const band = drawSelectionBand(lines, { start: 0, height: 1 }, 0, 20);
		const text = lineText(band[0]);
		assert.ok(text.includes("▸"), "caret replaces the bullet");
		assert.ok(!text.includes("◆"), "bullet removed");
		assert.equal(lineText(band[1]), "other", "neighbouring row untouched");
		const name = band[0].find((span) => span.text.includes("List"));
		assert.ok(name?.style?.background, "band background applied");
	});

	it("悬停浮卡贴着轨道左缘，盖住当行正文且列数不变", () => {
		const lines = Array.from({ length: 10 }, () => plain("x".repeat(40)));
		const card = drawHoverCard(lines, 5, 40, "hello");
		const mid = lineText(card[5]);
		const top = lineText(card[4]);
		assert.ok(top.includes("╭─") && top.includes("╮"), "card top border");
		assert.ok(mid.includes("│ hello │"), "preview sits inside the card");
		assert.ok(mid.includes("x".repeat(20)), "content left of the card survives");
		// 卡片右缘在轨道左边，右侧的尾段原样保留
		assert.equal(mid.length, 40);
		assert.ok(lineText(card[6]).includes("╰"), "card bottom border");
	});

	it("悬停时间戳原地向左展开，右对齐到时间戳右缘", () => {
		const line = plain(".".repeat(40));
		const expanded = lineText(expandTimestamp(line, 20, 10, "14:33:00 | Oct 17"));
		assert.equal(expanded.slice(13, 30), "14:33:00 | Oct 17");
		assert.ok(expanded.startsWith(".".repeat(13)));
	});
});
