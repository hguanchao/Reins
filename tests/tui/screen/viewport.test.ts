import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Viewport } from "../../../src/tui/screen/viewport.ts";

/** 内容 100 行、主区 10 行这种规模：窗口够小，边界一眼能算清。 */
const TOTAL = 100;
const ROWS = 10;

describe("Viewport", () => {
	it("默认跟尾：窗口贴着内容末尾", () => {
		const viewport = new Viewport();
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 90, following: true });
	});

	it("内容不足一屏时窗口从头开始，也算跟尾", () => {
		const viewport = new Viewport();
		assert.deepEqual(viewport.window(4, ROWS), { start: 0, following: true });
	});

	it("往上翻之后停在原地，新到的内容不会把窗口推走", () => {
		const viewport = new Viewport();
		viewport.scrollBy(-5, TOTAL, ROWS);
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 85, following: false });
		// 内容又长了几行，看的还是原来那几行
		assert.deepEqual(viewport.window(140, ROWS), { start: 85, following: false });
	});

	it("往下翻到底部就恢复跟尾", () => {
		const viewport = new Viewport();
		viewport.scrollBy(-5, TOTAL, ROWS);
		viewport.scrollBy(5, TOTAL, ROWS);
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 90, following: true });
	});

	it("翻页一步半屏，翻过头只停在边界", () => {
		const viewport = new Viewport();
		viewport.scrollPages(-1, TOTAL, ROWS);
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 85, following: false });

		viewport.scrollPages(-100, TOTAL, ROWS);
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 0, following: false });

		viewport.scrollPages(100, TOTAL, ROWS);
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 90, following: true });
	});

	it("跳到最早与回到末尾", () => {
		const viewport = new Viewport();
		viewport.toTop();
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 0, following: false });

		viewport.toEnd();
		assert.deepEqual(viewport.window(TOTAL, ROWS), { start: 90, following: true });
	});

	it("内容不够一屏时跳到最早，看着还是跟尾", () => {
		const viewport = new Viewport();
		viewport.toTop();
		assert.deepEqual(viewport.window(3, ROWS), { start: 0, following: true });
	});

	it("主区变高以后窗口不越界", () => {
		const viewport = new Viewport();
		viewport.scrollBy(-50, TOTAL, ROWS);
		// 窗口顶端 40 行，主区长到 80 行：最多只能从第 20 行开始，也就是贴回了末尾
		assert.deepEqual(viewport.window(TOTAL, 80), { start: 20, following: true });
	});
});
