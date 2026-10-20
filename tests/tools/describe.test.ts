import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeToolCall, displayToolName } from "../../src/tools/describe.ts";

describe("工具调用摘要", () => {
	it("工具名首字母大写，带命名空间的名称保持原样", () => {
		assert.equal(displayToolName("read"), "Read");
		assert.equal(displayToolName("bash"), "Bash");
		assert.equal(displayToolName("ls"), "List");
		assert.equal(displayToolName(""), "");
		assert.equal(displayToolName("mcp__fs__read"), "mcp__fs__read");
		assert.equal(displayToolName("plugin:search"), "plugin:search");
	});

	it("read 省略默认 offset，只在非默认时显示", () => {
		assert.deepEqual(describeToolCall("read", { path: "README.md" }), {
			name: "Read",
			detail: "README.md",
			group: "read",
		});
		assert.equal(describeToolCall("read", { path: "README.md", offset: 1 }).detail, "README.md");
		assert.equal(
			describeToolCall("read", { path: "README.md", offset: 100, limit: 130 }).detail,
			"README.md  [offset 100, limit 130]",
		);
	});

	it("write 显示路径与大小，edit 显示编辑条数", () => {
		assert.equal(
			describeToolCall("write", { path: "src/new.ts", content: "x".repeat(1234) }).detail,
			"src/new.ts  [1.2 KB]",
		);
		assert.equal(describeToolCall("write", { path: "a.ts", content: "hello" }).detail, "a.ts  [5 B]");
		assert.equal(
			describeToolCall("edit", { path: "src/auth.ts", edits: [{}, {}] }).detail,
			"src/auth.ts  [2 edits]",
		);
		assert.equal(
			describeToolCall("edit", { path: "src/auth.ts", edits: [{}] }).detail,
			"src/auth.ts  [1 edit]",
		);
		// 参数可能还是 JSON 字符串，条数照样要数对
		assert.equal(
			describeToolCall("edit", { path: "a.ts", edits: JSON.stringify([{}, {}, {}]) }).detail,
			"a.ts  [3 edits]",
		);
	});

	it("bash 直接显示命令，不经过 JSON 转义", () => {
		const call = describeToolCall("bash", { command: 'cd "E:\\Projects" && npm test' });

		assert.equal(call.name, "Bash");
		assert.equal(call.detail, 'cd "E:\\Projects" && npm test');
	});

	it("摘要压成单行，控制字符与转义序列不会进终端", () => {
		const call = describeToolCall("bash", {
			command: "echo a\necho b\t\x1b[31mred\x1b[0m",
		});

		assert.equal(call.detail, "echo a echo b red");
	});

	it("find、grep 与 ls 省略默认值和空参数", () => {
		assert.equal(
			describeToolCall("find", { pattern: "*.md", path: ".", limit: 50 }).detail,
			"*.md  [limit 50]",
		);
		assert.equal(describeToolCall("find", { pattern: "*.md" }).detail, "*.md");
		assert.equal(
			describeToolCall("grep", {
				pattern: "TODO",
				path: "src",
				glob: "*.ts",
				literal: true,
				ignoreCase: true,
				limit: 20,
			}).detail,
			"TODO  [in src, *.ts, literal, ignore case, limit 20]",
		);
		assert.equal(describeToolCall("ls", { path: "." }).detail, "");
		assert.equal(describeToolCall("ls", { limit: 10 }).detail, "[limit 10]");
		assert.deepEqual(describeToolCall("ls", { path: "server/core", limit: 10 }), {
			name: "List",
			detail: "server/core  [limit 10]",
			group: "list",
		});
	});

	it("subagent 只取任务首行并截断", () => {
		assert.equal(describeToolCall("subagent", { task: "do it\nmore" }).detail, "do it");

		const long = describeToolCall("subagent", { task: "x".repeat(200) }).detail;
		assert.equal(Array.from(long).length, 121);
		assert.ok(long.endsWith("…"));
	});

	it("未知工具回退到紧凑 JSON，空对象不留摘要", () => {
		assert.deepEqual(describeToolCall("mcp__fs__list", { path: "a" }), {
			name: "mcp__fs__list",
			detail: '{"path":"a"}',
		});
		assert.equal(describeToolCall("mcp__fs__list", {}).detail, "");

		const long = describeToolCall("mcp__fs__list", { q: "x".repeat(300) }).detail;
		assert.equal(Array.from(long).length, 161);
		assert.ok(long.endsWith("…"));
	});

	it("只读探索工具带分组类型，其他工具没有", () => {
		assert.equal(describeToolCall("read", { path: "a.ts" }).group, "read");
		assert.equal(describeToolCall("ls", {}).group, "list");
		assert.equal(describeToolCall("find", { pattern: "*" }).group, "search");
		assert.equal(describeToolCall("grep", { pattern: "x" }).group, "search");
		assert.equal(describeToolCall("bash", { command: "x" }).group, undefined);
		assert.equal(describeToolCall("mcp__fs__read", {}).group, undefined);
	});

	it("缺少必填参数时给出占位，不显示 undefined", () => {
		assert.equal(describeToolCall("read", {}).detail, "(missing path)");
		assert.equal(describeToolCall("bash", {}).detail, "(no command)");
	});
});
