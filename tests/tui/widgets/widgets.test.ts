import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lineText } from "../../../src/tui/text/line.ts";
import { formatDuration, spinnerFrame, spinnerLine } from "../../../src/tui/widgets/spinner.ts";

describe("spinnerFrame", () => {
	it("按时间取帧，同一段时间内保持不变", () => {
		assert.equal(spinnerFrame(0), spinnerFrame(50));
		assert.notEqual(spinnerFrame(0), spinnerFrame(120));
	});

	it("时间倒流也不会取到不存在的帧", () => {
		assert.equal(spinnerFrame(-1000), "⠋");
	});
});

describe("formatDuration", () => {
	it("毫秒、秒、分钟各有各的写法", () => {
		assert.equal(formatDuration(12), "12ms");
		assert.equal(formatDuration(999), "999ms");
		assert.equal(formatDuration(1500), "1.5s");
		assert.equal(formatDuration(65_000), "1m05s");
	});
});

describe("spinnerLine", () => {
	it("指示器与文字拼成一行", () => {
		const line = spinnerLine("正在思考", 0);
		assert.equal(lineText(line), "⠋ 正在思考 0ms");
	});
});


