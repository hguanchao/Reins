import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CENTER_MIN,
	RIGHTBAR_MIN,
	SIDEBAR_MAX,
	SIDEBAR_MIN,
	clampSidebar,
	computeColumns,
	defaultRightbarWidth,
} from "#web/shell/columns.ts";

describe("侧栏宽度收敛", () => {
	it("低于下限抬到 264，高于上限压到 420", () => {
		assert.equal(clampSidebar(120), SIDEBAR_MIN);
		assert.equal(clampSidebar(600), SIDEBAR_MAX);
		assert.equal(clampSidebar(280), 280);
	});

	it("四舍五入到整数像素", () => {
		assert.equal(clampSidebar(280.6), 281);
	});
});

describe("三栏求解", () => {
	it("常规窗口保留主列最小宽度并给出右栏", () => {
		const widths = computeColumns(1440, 280, defaultRightbarWidth(1440));
		assert.equal(widths.sidebar, 280);
		assert.equal(widths.rightbar, 648);
		assert.equal(widths.center, 1440 - 280 - 648);
	});

	it("右栏空间不足时整条让出，主列不被压缩", () => {
		const widths = computeColumns(900, 280, 500);
		assert.equal(widths.rightbar, 0);
		assert.equal(widths.center, 900 - 280);
	});

	it("窗口极窄时主列可以降为零", () => {
		const widths = computeColumns(320, 280, 0);
		assert.equal(widths.sidebar, 280);
		assert.equal(widths.center, 40);
		assert.ok(widths.center < CENTER_MIN);
	});

	it("右栏下限 300，上限不超过窗口 70%", () => {
		assert.equal(computeColumns(1440, 280, 100).rightbar, RIGHTBAR_MIN);
		const wide = computeColumns(2400, 280, 2000);
		assert.equal(wide.rightbar, Math.round(2400 * 0.7));
	});

	it("收起侧栏与关闭右栏都是零宽", () => {
		const widths = computeColumns(1200, 0, 0);
		assert.deepEqual(widths, { sidebar: 0, center: 1200, rightbar: 0 });
	});
});
