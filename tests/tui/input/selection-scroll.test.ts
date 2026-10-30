import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dragScrollSpeed } from "#src/tui/input/selection-scroll.ts";

describe("拖选自动滚动的速度", () => {
	it("贴着边缘慢、拖远了快", () => {
		assert.equal(dragScrollSpeed(1), 1);
		assert.equal(dragScrollSpeed(2), 2);
		assert.equal(dragScrollSpeed(3), 2);
		assert.equal(dragScrollSpeed(4), 3);
		assert.equal(dragScrollSpeed(6), 3);
		assert.equal(dragScrollSpeed(7), 5);
	});
});
