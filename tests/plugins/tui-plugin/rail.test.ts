import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeTurn, railCells, railWidth } from "../../../src/plugins/tui-plugin/rail.ts";

describe("回合轨道", () => {
	it("窄终端或回合太少时不显示", () => {
		assert.equal(railWidth({ width: 80, turns: 2 }), 2);
		assert.equal(railWidth({ width: 59, turns: 2 }), 0);
		assert.equal(railWidth({ width: 80, turns: 1 }), 0);
	});

	it("刻度横跨两列，箭头只落在靠右一列，都带点击后要跳到的行号", () => {
		const cells = railCells(20, [0, 30], 10);
		assert.equal(cells[0].text, " ▴");
		assert.equal(cells[0].target, 0);
		assert.equal(cells[19].text, " ▾");
		assert.equal(cells[19].target, 30);

		const ticks = cells.filter((cell) => cell.text === "━━" || cell.text === " ─");
		assert.equal(ticks.length, 2);
		assert.deepEqual(
			ticks.map((cell) => cell.target),
			[0, 30],
		);
		// 视口顶端所在的回合用双线点亮，其余刻度只画一半
		const active = cells.find((cell) => cell.text === "━━");
		const idle = cells.find((cell) => cell.text === " ─");
		assert.ok(active, "active tick drawn");
		assert.ok(idle, "idle tick drawn");
		assert.equal(active.target, 0, "viewport top sits in the first turn");
	});

	it("鼠标悬停的刻度亮起", () => {
		const cells = railCells(20, [0, 30], 10, 30);
		const hover = cells.find((cell) => cell.text === "──");
		assert.ok(hover, "hovered tick brightens");
		assert.equal(hover.target, 30);
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
