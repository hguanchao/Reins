import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CAPTION_HEIGHT,
	themeFromSystem,
	titleBarOverlay,
	windowBackgroundColor,
} from "#desktop/theme.ts";

describe("桌面窗口主题", () => {
	it("标题栏高度与界面令牌一致", () => {
		assert.equal(CAPTION_HEIGHT, 34);
		assert.equal(titleBarOverlay("zai-light").height, 34);
		assert.equal(titleBarOverlay("zai-dark").height, 34);
	});

	it("窗口底色跟随实际主题，系统深浅色不是第三套配色", () => {
		assert.equal(windowBackgroundColor("zai-light"), "#f6f6f5");
		assert.equal(windowBackgroundColor("zai-dark"), "#090909");
		assert.equal(themeFromSystem(true), "zai-dark");
		assert.equal(themeFromSystem(false), "zai-light");
	});

	it("标题栏覆盖层颜色与窗口底色同源，符号色取反", () => {
		assert.deepEqual(titleBarOverlay("zai-light"), {
			color: "#f6f6f5",
			symbolColor: "#0b0b0b",
			height: 34,
		});
		assert.deepEqual(titleBarOverlay("zai-dark"), {
			color: "#090909",
			symbolColor: "#f2f2f0",
			height: 34,
		});
	});
});
