import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCount, formatDuration } from "#src/shared/format.ts";

describe("耗时格式", () => {
	it("秒起步保留一位小数,不出现毫秒", () => {
		assert.equal(formatDuration(0), "0.0s");
		assert.equal(formatDuration(500), "0.5s");
		assert.equal(formatDuration(999), "1.0s");
		assert.equal(formatDuration(1234), "1.2s");
		assert.equal(formatDuration(59_949), "59.9s");
	});

	it("分、时、天逐级收敛,单位之间没有空格", () => {
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(65_000), "1m5s");
		assert.equal(formatDuration(3_600_000), "1h");
		assert.equal(formatDuration(3_665_000), "1h1m");
		assert.equal(formatDuration(86_400_000), "1d");
		assert.equal(formatDuration(90_000_000), "1d1h");
	});

	it("负数与非有限值按 0 处理", () => {
		assert.equal(formatDuration(-300), "0.0s");
		assert.equal(formatDuration(Number.NaN), "0.0s");
	});
});

describe("计数格式", () => {
	it("四位以上加千分位，三位以内原样", () => {
		assert.equal(formatCount(0), "0");
		assert.equal(formatCount(11), "11");
		assert.equal(formatCount(999), "999");
		assert.equal(formatCount(1_000), "1,000");
		assert.equal(formatCount(1_234), "1,234");
		assert.equal(formatCount(1_234_567), "1,234,567");
	});

	it("负数与小数按整数处理", () => {
		assert.equal(formatCount(-5), "0");
		assert.equal(formatCount(12.6), "13");
	});
});
