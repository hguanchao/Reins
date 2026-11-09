import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { themeFromSystem, windowBackgroundColor } from "#desktop/theme.ts";

describe("桌面窗口主题", () => {
	it("窗口底色跟随实际主题，系统深浅色不是第三套配色", () => {
		assert.equal(windowBackgroundColor("zai-light"), "#f6f6f5");
		assert.equal(windowBackgroundColor("zai-dark"), "#090909");
		assert.equal(themeFromSystem(true), "zai-dark");
		assert.equal(themeFromSystem(false), "zai-light");
	});
});
