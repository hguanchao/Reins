import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, offsetToLineColumn } from "#src/config/error.ts";

describe("配置错误", () => {
	it("display: 无位置时只给消息", () => {
		const error = new ConfigError("something wrong");
		assert.equal(error.display, "something wrong");
		assert.equal(error.file, undefined);
	});

	it("display: 只有文件时给文件加消息", () => {
		const error = new ConfigError("boom", { file: "config.toml" });
		assert.equal(error.display, "config.toml boom");
	});

	it("display: 文件加行列", () => {
		const error = new ConfigError("boom", { file: "config.toml", line: 3, column: 5 });
		assert.equal(error.display, "config.toml:3:5 boom");
	});

	it("缺列号时按 1 报", () => {
		const error = new ConfigError("boom", { file: "c.toml", line: 2 });
		assert.equal(error.display, "c.toml:2:1 boom");
	});

	it("withFile 保留行列并补上文件", () => {
		const error = new ConfigError("boom", { line: 4, column: 2 });
		const moved = error.withFile("a.toml");
		assert.equal(moved.display, "a.toml:4:2 boom");
	});
});

describe("偏移到行列", () => {
	it("第一行偏移 0 是 1 行 1 列", () => {
		assert.deepEqual(offsetToLineColumn("abc", 0), { line: 1, column: 1 });
	});

	it("换行后行号推进，列号从 1 重新数", () => {
		assert.deepEqual(offsetToLineColumn("ab\ncd", 4), { line: 2, column: 2 });
	});

	it("CRLF 当成一行一处换行", () => {
		assert.deepEqual(offsetToLineColumn("ab\r\ncd", 5), { line: 2, column: 2 });
	});

	it("偏移超出按串尾计算", () => {
		assert.deepEqual(offsetToLineColumn("ab", 99), { line: 1, column: 3 });
	});
});
