import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeTurn, appendRail, railCells, railWidth, RAIL_WIDTH } from "../../../src/plugins/tui-plugin/rail.ts";
import { ACCENT, EDGE_LIT, FAINT } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText, lineWidth, plain } from "../../../src/tui/index.ts";

describe("回合轨道", () => {
	it("窄屏或只有一个回合时不占列", () => {
		assert.equal(railWidth({ width: 59, turns: 3 }), 0);
		assert.equal(railWidth({ width: 60, turns: 1 }), 0);
		assert.equal(railWidth({ width: 80, turns: 2 }), RAIL_WIDTH);
	});

	it("当前回合是视口顶端落在的那一个", () => {
		assert.equal(activeTurn([0, 10, 20], 0), 0);
		assert.equal(activeTurn([0, 10, 20], 12), 10);
		assert.equal(activeTurn([0, 10, 20], 99), 20);
	});

	it("两端是箭头，中间一格一回合，当前那格点亮", () => {
		const cells = railCells(7, [0, 10, 20], 10);
		assert.equal(cells.length, 7);
		assert.equal(cells[0].text.trim(), "▴");
		assert.equal(cells[6].text.trim(), "▾");

		const ticks = cells.filter((cell) => cell.text.includes("━") || cell.text.includes("─"));
		assert.equal(ticks.length, 3);
		const lit = ticks.filter((cell) => cell.text === "━━");
		assert.equal(lit.length, 1);
		assert.equal(lit[0].style, ACCENT);
	});

	it("视口之外没有回合时箭头变暗", () => {
		// 顶端就在第一回合：上面没得跳；下面还有两回合
		const top = railCells(6, [0, 10, 20], 0);
		assert.equal(top[0].style, FAINT);
		assert.equal(top[5].style, EDGE_LIT);

		// 翻到最后一个回合：下面没得跳
		const bottom = railCells(6, [0, 10, 20], 20);
		assert.equal(bottom[0].style, EDGE_LIT);
		assert.equal(bottom[5].style, FAINT);
	});

	it("回合比行数多时开一扇窗，当前回合始终在窗里", () => {
		const turns = Array.from({ length: 40 }, (_, index) => index * 10);
		const cells = railCells(6, turns, 200);
		const ticks = cells.filter((cell) => cell.text.includes("━") || cell.text.includes("─"));
		assert.equal(ticks.length, 4);
		assert.equal(ticks.filter((cell) => cell.text === "━━").length, 1);
	});

	it("行数太少时一格都不画", () => {
		assert.deepEqual(railCells(3, [0, 10], 0).map((cell) => cell.text), ["  ", "  ", "  "]);
		assert.equal(railCells(10, [], 0).every((cell) => cell.text === "  "), true);
	});

	it("刻度接到行尾，占满两列", () => {
		const line = appendRail(plain("正文"), { text: "━━", style: ACCENT });
		assert.equal(lineText(line), "正文━━");
		assert.equal(lineWidth(line), 6);
	});
});
