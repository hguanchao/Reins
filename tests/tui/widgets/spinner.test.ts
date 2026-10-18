import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration, spinnerFrame, spinnerLine } from "../../../src/tui/widgets/spinner.ts";
import { lineText } from "../../../src/tui/text/line.ts";

describe("旋转指示器", () => {
	it("按时间取帧，循环播放", () => {
		const first = spinnerFrame(0);
		assert.notEqual(first, spinnerFrame(120));
		assert.equal(spinnerFrame(8 * 120 + 60), first); // 走完一圈回到第一帧
		assert.equal(spinnerFrame(-5), spinnerFrame(0)); // 负数夹到 0
	});

	it("状态行带指示器与耗时，指示器是灰色的", () => {
		const line = spinnerLine("thinking", 150);
		assert.equal(lineText(line).trim(), "⠙ thinking 150ms");
		assert.deepEqual(line[0].style, { color: "gray" });
	});
});

describe("耗时写法", () => {
	it("毫秒、秒、分秒", () => {
		assert.equal(formatDuration(5), "5ms");
		assert.equal(formatDuration(999), "999ms");
		assert.equal(formatDuration(1000), "1.0s");
		assert.equal(formatDuration(9_960), "10.0s");
		assert.equal(formatDuration(15_400), "15s");
		assert.equal(formatDuration(61_000), "1m1s");
		assert.equal(formatDuration(59_600), "1m0s");
		assert.equal(formatDuration(3_725_000), "1h2m");
		assert.equal(formatDuration(-2), "0ms");
	});
});
