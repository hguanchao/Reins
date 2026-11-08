import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CENTER_MIN,
	COMPACT_WINDOW,
	RIGHTBAR_DEFAULT,
	RIGHTBAR_MAX,
	RIGHTBAR_MIN,
	SIDEBAR_DEFAULT,
	SIDEBAR_MAX,
	SIDEBAR_MIN,
	clampRightbar,
	clampSidebar,
	computeColumns,
	defaultRightbarWidth,
} from "#web/shell/columns.ts";

describe("侧栏宽度收敛", () => {
	it("demo 基准 244px，拖拽范围 180–320", () => {
		assert.equal(SIDEBAR_DEFAULT, 244);
		assert.equal(SIDEBAR_MIN, 180);
		assert.equal(SIDEBAR_MAX, 320);
		assert.equal(clampSidebar(120), SIDEBAR_MIN);
		assert.equal(clampSidebar(600), SIDEBAR_MAX);
		assert.equal(clampSidebar(244), 244);
	});

	it("四舍五入到整数像素", () => {
		assert.equal(clampSidebar(244.6), 245);
	});
});

describe("右面板宽度收敛", () => {
	it("默认 308px，拖拽范围 300–420", () => {
		assert.equal(RIGHTBAR_DEFAULT, 308);
		assert.equal(defaultRightbarWidth(1440), 308);
		assert.equal(clampRightbar(100, 1440), RIGHTBAR_MIN);
		assert.equal(clampRightbar(900, 1440), RIGHTBAR_MAX);
	});

	it("窄窗里不超过窗口 70%", () => {
		assert.ok(clampRightbar(420, 500) <= Math.round(500 * 0.7));
	});
});

describe("窄窗断点", () => {
	it("900px 以下与设计稿一致：侧栏与面板整条隐藏", () => {
		assert.equal(COMPACT_WINDOW, 900);
		assert.deepEqual(computeColumns(900, 244, 308), { sidebar: 0, center: 900, rightbar: 0 });
		assert.deepEqual(computeColumns(640, 0, 308), { sidebar: 0, center: 640, rightbar: 0 });
	});
});

describe("三栏求解", () => {
	it("常规窗口按 demo 给出 244 / 308 / 剩余", () => {
		const widths = computeColumns(1440, SIDEBAR_DEFAULT, defaultRightbarWidth(1440));
		assert.equal(widths.sidebar, 244);
		assert.equal(widths.rightbar, 308);
		assert.equal(widths.center, 1440 - 244 - 308);
	});

	it("右栏空间不足时按可用宽度收敛，主列不被压缩", () => {
		const widths = computeColumns(960, 244, 500);
		assert.equal(widths.sidebar, 210);
		assert.equal(widths.rightbar, 960 - 210 - CENTER_MIN);
	});

	it("可用宽度低于右栏下限时整条让出", () => {
		const widths = computeColumns(905, 244, 500);
		assert.equal(widths.rightbar, 0);
		assert.equal(widths.center, 905 - 210);
	});

	it("窗口极窄时主列可以降为零", () => {
		const widths = computeColumns(1000, 244, 0);
		assert.equal(widths.sidebar, 210);
		assert.equal(widths.center, 790);
		assert.ok(widths.center < CENTER_MIN + 400);
	});

	it("右栏下限 300、上限 420", () => {
		assert.equal(computeColumns(1440, 244, 100).rightbar, RIGHTBAR_MIN);
		assert.equal(computeColumns(2400, 244, 2000).rightbar, RIGHTBAR_MAX);
	});

	it("窄窗把侧栏收到设计稿的 210px，宽窗恢复 244", () => {
		assert.equal(computeColumns(1064, 244, 0).sidebar, 210);
		assert.equal(computeColumns(1180, 280, 0).sidebar, 210);
		assert.equal(computeColumns(1440, 244, 0).sidebar, 244);
	});

	it("收起侧栏与关闭右栏都是零宽", () => {
		const widths = computeColumns(1200, 0, 0);
		assert.deepEqual(widths, { sidebar: 0, center: 1200, rightbar: 0 });
	});
});
