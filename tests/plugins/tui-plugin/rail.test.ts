import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeTurn, railCells, railWidth } from "../../../src/plugins/tui-plugin/rail.ts";

describe("回合轨道", () => {
	it("窄终端或回合太少时不显示", () => {
		assert.equal(railWidth({ width: 80, turns: 2 }), 1);
		assert.equal(railWidth({ width: 59, turns: 2 }), 0);
		assert.equal(railWidth({ width: 80, turns: 1 }), 0);
	});

	it("刻度与箭头带点击后要跳到的行号", () => {
		const cells = railCells(20, [0, 30], 10);
		assert.equal(cells[0].text, "▴");
		assert.equal(cells[0].target, 0);
		assert.equal(cells[19].text, "▾");
		assert.equal(cells[19].target, 30);

		const ticks = cells.filter((cell) => cell.text === "━" || cell.text === "─");
		assert.equal(ticks.length, 2);
		assert.deepEqual(
			ticks.map((cell) => cell.target),
			[0, 30],
		);
	});

	it("翻到顶部时上箭头没有目标，下箭头仍可跳到后面的回合", () => {
		const cells = railCells(10, [0, 5], 0);
		assert.equal(cells[0].target, undefined);
		assert.equal(cells[9].target, 5);
	});

	it("activeTurn 取视口顶端所在的回合", () => {
		assert.equal(activeTurn([0, 10, 20], 15), 10);
		assert.equal(activeTurn([0, 10, 20], 0), 0);
	});
});
