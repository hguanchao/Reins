import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrollButtonHit, scrollButtonPlacement } from "../../src/tui/scroll-button.ts";
import { THEME } from "../../src/tui/theme.ts";

describe("置底按钮", () => {
	it("贴在对话流最后一行右端，最后一列留给滚动条", () => {
		const placement = scrollButtonPlacement(40, 6);
		assert.ok(placement);
		assert.equal(placement.row, 6);
		assert.equal(placement.column, 35);
		assert.equal(placement.width, 5);
		// 右边界停在 width - 1，滚动条占最后一列
		assert.equal(placement.column + placement.width - 1, 39);
		assert.ok(placement.text.includes("▼"));
		assert.ok(placement.text.includes(THEME.surface));
		assert.ok(placement.text.includes(THEME.textSubtle));
		assert.ok(placement.text.endsWith(THEME.reset));
	});

	it("悬停只换符号颜色，位置与命中区不变", () => {
		const idle = scrollButtonPlacement(40, 6);
		const hovered = scrollButtonPlacement(40, 6, true);
		assert.ok(idle);
		assert.ok(hovered);
		assert.equal(hovered.row, idle.row);
		assert.equal(hovered.column, idle.column);
		assert.equal(hovered.width, idle.width);
		assert.equal(hovered.hitColumn, idle.hitColumn);
		assert.equal(hovered.hitWidth, idle.hitWidth);
		assert.equal(hovered.text.includes(THEME.accent), true);
		assert.equal(hovered.text.includes(THEME.textSubtle), false);
		assert.equal(idle.text.includes(THEME.accent), false);
	});

	it("命中区比按钮左侧宽一列，右侧不侵入滚动条", () => {
		const placement = scrollButtonPlacement(40, 6);
		assert.ok(placement);
		assert.equal(placement.hitColumn, 34);
		assert.equal(placement.hitWidth, 6);
		assert.equal(placement.hitColumn + placement.hitWidth - 1, 39);
	});

	it("没有高度或终端太窄时不画", () => {
		assert.equal(scrollButtonPlacement(40, 0), undefined);
		assert.equal(scrollButtonPlacement(0, 6), undefined);
		assert.equal(scrollButtonPlacement(6, 6), undefined);
	});

	it("刚好放得下时左侧仍留出正文", () => {
		const placement = scrollButtonPlacement(7, 3);
		assert.ok(placement);
		assert.equal(placement.column, 2);
		assert.equal(placement.column + placement.width - 1, 6);
		assert.equal(placement.hitColumn, 1);
	});

	it("命中只看按钮覆盖的行与列区间", () => {
		const placement = scrollButtonPlacement(40, 6);
		assert.ok(placement);
		assert.equal(scrollButtonHit(placement, 6, 34), true);
		assert.equal(scrollButtonHit(placement, 6, 35), true);
		assert.equal(scrollButtonHit(placement, 6, 39), true);
		assert.equal(scrollButtonHit(placement, 6, 33), false);
		assert.equal(scrollButtonHit(placement, 6, 40), false);
		assert.equal(scrollButtonHit(placement, 5, 35), false);
	});
});
