import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderFooter } from "../../src/tui/footer.ts";

describe("页脚", () => {
	it("平时只保留一行空白，占住整屏的最后一行", () => {
		assert.deepEqual(renderFooter(false, 40), [""]);
	});

	it("第一次按 Ctrl+C 后提示再按一次", () => {
		assert.deepEqual(renderFooter(true, 40), ["Press Ctrl+C again to exit"]);
	});

	it("窗口比提示还窄时截断，不撑破布局", () => {
		assert.deepEqual(renderFooter(true, 5), ["Press"]);
	});
});
