import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PLUGIN_LOG_LIMIT, PluginLogBuffer } from "#src/plugins/logs.ts";

describe("插件日志缓冲", () => {
	it("按插件分桶，互不串线", () => {
		const buffer = new PluginLogBuffer();
		buffer.record("a", "info", "alpha");
		buffer.record("b", "warn", "beta");

		assert.deepEqual(
			buffer.lines("a").map((line) => line.message),
			["alpha"],
		);
		assert.deepEqual(
			buffer.lines("b").map((line) => line.message),
			["beta"],
		);
		assert.deepEqual(buffer.lines("missing"), []);
	});

	it("超过上限只保留最近 200 条", () => {
		const buffer = new PluginLogBuffer();
		for (let index = 0; index < PLUGIN_LOG_LIMIT + 5; index += 1) {
			buffer.record("a", "info", String(index));
		}
		const lines = buffer.lines("a");
		assert.equal(lines.length, PLUGIN_LOG_LIMIT);
		assert.equal(lines[0]?.message, "5");
		assert.equal(lines[lines.length - 1]?.message, String(PLUGIN_LOG_LIMIT + 4));
	});

	it("清洗 ANSI、控制字符与换行", () => {
		const buffer = new PluginLogBuffer();
		buffer.record("a", "info", "\u001b[31mred\u001b[0m\nline2\tend\u0007");
		assert.equal(buffer.lines("a")[0]?.message, "red line2\tend");
	});

	it("超长消息截断到 4000 字符", () => {
		const buffer = new PluginLogBuffer();
		buffer.record("a", "info", "x".repeat(5_000));
		assert.equal(buffer.lines("a")[0]?.message.length, 4_000);
	});

	it("lines 支持只取最近几条", () => {
		const buffer = new PluginLogBuffer();
		for (const message of ["one", "two", "three"]) buffer.record("a", "info", message);
		assert.deepEqual(
			buffer.lines("a", 2).map((line) => line.message),
			["two", "three"],
		);
	});
});
