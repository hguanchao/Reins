import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	describeTool,
	displayPath,
	firstLine,
	lastOutputLine,
	timestampText,
	toolSummary,
} from "../../../src/plugins/tui-plugin/transcript-format.ts";

describe("工具摘要", () => {
	it("读取类工具显示相对路径与偏移量", () => {
		assert.equal(
			toolSummary("read", { path: "E:\\w\\src\\a.ts", offset: 10, limit: 5 }, "E:\\w"),
			"src/a.ts (10–15)",
		);
		assert.equal(toolSummary("write", { path: "E:\\w\\a.ts" }, "E:\\w"), "a.ts");
	});

	it("检索与命令类工具取主参数", () => {
		assert.equal(toolSummary("grep", { pattern: "needle", path: "src" }, "E:\\w"), '"needle" src');
		assert.equal(toolSummary("bash", { command: "npm test" }, "E:\\w"), "npm test");
		assert.equal(toolSummary("websearch", { query: "terminal" }, "E:\\w"), "terminal");
	});

	it("未知工具只列前三个键值", () => {
		assert.equal(toolSummary("custom", { a: 1, b: "x", c: true, d: "ignored" }, undefined), "a=1 b=x c=true");
	});

	it("摘要过长时截断，displayPath 统一斜杠", () => {
		const long = describeTool("bash", { command: "x".repeat(100) }, undefined);
		assert.ok(long.length <= 61);
		assert.ok(long.endsWith("…"));
		assert.equal(displayPath("C:\\work\\src\\a.ts", "C:\\work"), "src/a.ts");
	});
});

describe("会话文字", () => {
	it("时间戳为 12 小时制", () => {
		assert.equal(timestampText(new Date(2026, 9, 17, 9, 5).getTime()), "  9:05 AM");
		assert.equal(timestampText(new Date(2026, 9, 17, 14, 33).getTime()), "  2:33 PM");
	});

	it("输出尾部与回合预览只取非空行", () => {
		assert.equal(lastOutputLine("one\n\ntwo"), "two");
		assert.equal(lastOutputLine(""), undefined);
		assert.equal(firstLine("\n  hello  \nworld"), "hello");
	});
});
