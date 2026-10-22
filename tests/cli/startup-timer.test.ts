import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStartupTimer } from "../../src/cli/startup-timer.ts";

/** 按顺序吐出预置时间戳的假时钟；用完之后一直返回最后一个值 */
function clock(...ticks: readonly number[]): () => number {
	let index = 0;
	return () => ticks[Math.min(index++, ticks.length - 1)] ?? 0;
}

describe("启动计时", () => {
	it("没设置环境变量时什么也不输出", () => {
		const lines: string[] = [];
		const timer = createStartupTimer({
			env: {},
			write: (line) => lines.push(line),
			now: clock(0, 10, 30),
		});

		timer.mark("config");
		timer.mark("plugins");
		timer.report();

		assert.deepEqual(lines, []);
	});

	it("按阶段输出各自耗时与总计", () => {
		const lines: string[] = [];
		const timer = createStartupTimer({
			env: { REINS_DEBUG_STARTUP: "1" },
			write: (line) => lines.push(line),
			now: clock(0, 10, 30),
		});

		timer.mark("config");
		timer.mark("plugins");
		timer.report();

		assert.equal(lines[0], "startup\n");
		// 阶段名左对齐到 14 列，耗时跟在后面
		assert.match(lines[1] ?? "", /^ {2}config {8}10\.0ms\n$/);
		assert.match(lines[2] ?? "", /^ {2}plugins {7}20\.0ms\n$/);
		assert.match(lines[3] ?? "", /^ {2}total {9}30\.0ms\n$/);
		assert.equal(lines.length, 4);
	});

	it("没有阶段被记录时不打表头", () => {
		const lines: string[] = [];
		const timer = createStartupTimer({
			env: { REINS_DEBUG_STARTUP: "1" },
			write: (line) => lines.push(line),
			now: clock(0),
		});

		timer.report();

		assert.deepEqual(lines, []);
	});

	it("环境变量为空串时按未启用处理", () => {
		const lines: string[] = [];
		const timer = createStartupTimer({
			env: { REINS_DEBUG_STARTUP: "" },
			write: (line) => lines.push(line),
			now: clock(0, 5),
		});

		timer.mark("config");
		timer.report();

		assert.deepEqual(lines, []);
	});
});
