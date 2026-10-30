import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrollButtonHit, scrollButtonPlacement } from "#src/tui/view/scroll-button.ts";
import { THEME } from "#src/tui/render/theme.ts";

describe("置底按钮", () => {
	it("贴在对话流最后一行底部居中，最后一列留给滚动条", () => {
		const placement = scrollButtonPlacement(40, 6);
		assert.ok(placement);
		assert.equal(placement.row, 6);
		assert.equal(placement.column, 18);
		assert.equal(placement.width, 5);
		// 居中按滚动条左侧的正文区算，左右余量必须相等
		const rightEdge = placement.column + placement.width - 1;
		assert.equal(rightEdge, 22);
		assert.equal(placement.column - 1, 39 - rightEdge);
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

	it("命中区在按钮左右各宽一列，不侵入滚动条", () => {
		const placement = scrollButtonPlacement(40, 6);
		assert.ok(placement);
		assert.equal(placement.hitColumn, 17);
		assert.equal(placement.hitWidth, 7);
		// 命中区左右对称外扩，右边界仍在正文区内，碰不到最后一列的滚动条
		assert.equal(placement.hitColumn, placement.column - 1);
		assert.equal(placement.hitColumn + placement.hitWidth - 1, placement.column + placement.width);
		assert.ok(placement.hitColumn + placement.hitWidth - 1 < 40);
	});

	it("没有高度或终端太窄时不画", () => {
		assert.equal(scrollButtonPlacement(40, 0), undefined);
		assert.equal(scrollButtonPlacement(0, 6), undefined);
		assert.equal(scrollButtonPlacement(6, 6), undefined);
	});

	it("刚好放得下时也居中，命中区停在滚动条左侧", () => {
		const placement = scrollButtonPlacement(7, 3);
		assert.ok(placement);
		assert.equal(placement.column, 1);
		assert.equal(placement.column + placement.width - 1, 5);
		assert.equal(placement.hitColumn, 1);
		// 第 7 列是滚动条，命中区最多到第 6 列
		assert.equal(placement.hitColumn + placement.hitWidth - 1, 6);
	});

	it("命中只看按钮覆盖的行与列区间", () => {
		const placement = scrollButtonPlacement(40, 6);
		assert.ok(placement);
		assert.equal(scrollButtonHit(placement, 6, 17), true);
		assert.equal(scrollButtonHit(placement, 6, 18), true);
		assert.equal(scrollButtonHit(placement, 6, 23), true);
		assert.equal(scrollButtonHit(placement, 6, 16), false);
		assert.equal(scrollButtonHit(placement, 6, 24), false);
		assert.equal(scrollButtonHit(placement, 5, 18), false);
	});
});
