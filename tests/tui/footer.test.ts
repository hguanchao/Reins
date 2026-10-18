import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderFooter } from "../../src/tui/footer.ts";

describe("页脚", () => {
	it("保留一行空白，占住整屏的最后一行", () => {
		assert.deepEqual(renderFooter(), [""]);
	});
});
