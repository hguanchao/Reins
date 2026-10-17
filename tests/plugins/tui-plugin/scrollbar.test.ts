import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SCROLLBAR_WIDTH,
	scrollbarCell,
	scrollbarGrabOffset,
	scrollbarStart,
	scrollbarState,
} from "../../../src/plugins/tui-plugin/scrollbar.ts";

describe("滚动条", () => {
	it("占一列，内容不足一屏时什么都不画", () => {
		assert.equal(SCROLLBAR_WIDTH, 1);
		assert.equal(scrollbarState(10, 10, 0).size, 0);
		assert.equal(scrollbarCell(0, 10, 10, 0).text, " ");
	});

	it("滑块高度按可见比例算，至少一格", () => {
		assert.equal(scrollbarState(100, 20, 0).size, 4);
		assert.equal(scrollbarState(1000, 20, 0).size, 1);
	});

	it("滑块位置跟随视口顶端，轨道用细线", () => {
		assert.equal(scrollbarState(100, 20, 0).top, 0);
		assert.equal(scrollbarState(100, 20, 80).top, 16);
		assert.equal(scrollbarCell(0, 100, 20, 0).text, "█");
		assert.equal(scrollbarCell(19, 100, 20, 0).text, "│");
	});

	it("按在滑块上抓偏移，按在轨道上抓滑块中心", () => {
		assert.equal(scrollbarGrabOffset(1, 100, 20, 0), 1);
		assert.equal(scrollbarGrabOffset(5, 100, 20, 0), 2);
		assert.equal(scrollbarGrabOffset(5, 10, 20, 0), undefined);
	});

	it("拖动行换算成视口顶端，越界夹紧", () => {
		assert.equal(scrollbarStart(0, 2, 100, 20), 0);
		assert.equal(scrollbarStart(19, 0, 100, 20), 80);
		assert.equal(scrollbarStart(999, 0, 100, 20), 80);
		assert.equal(scrollbarStart(0, 999, 100, 20), 0);
	});
});
