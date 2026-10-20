import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration } from "../../src/tools/format.ts";

describe("耗时格式", () => {
	it("按毫秒、秒、分、时、天逐级显示", () => {
		assert.equal(formatDuration(0), "0ms");
		assert.equal(formatDuration(999), "999ms");
		assert.equal(formatDuration(1000), "1s");
		assert.equal(formatDuration(1234), "1.2s");
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(65_000), "1m 5s");
		assert.equal(formatDuration(3_600_000), "1h");
		assert.equal(formatDuration(3_665_000), "1h 1m");
		assert.equal(formatDuration(86_400_000), "1d");
		assert.equal(formatDuration(90_000_000), "1d 1h");
	});
});
