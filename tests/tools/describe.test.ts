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

	it("read 折叠只留文件名，展开内容由结果决定", () => {
		assert.deepEqual(describeToolCall("read", { path: "README.md" }), {
			name: "Read",
			detail: "README.md",
			group: "read",
		});
		assert.equal(describeToolCall("read", { path: "README.md", offset: 1 }).fullDetail, undefined);

		const ranged = describeToolCall("read", { path: "README.md", offset: 100, limit: 130 });
		assert.equal(ranged.detail, "README.md");
		assert.equal(ranged.fullDetail, undefined);

		const nested = describeToolCall("read", { path: "src/a.ts" });
		assert.equal(nested.detail, "a.ts");
		assert.equal(nested.fullDetail, undefined);
	});

	it("write 折叠只留文件名，完整路径、大小与内容预览放在展开里", () => {
		const call = describeToolCall("write", { path: "src/new.ts", content: "x".repeat(1234) });

		assert.equal(call.detail, "new.ts");
		assert.ok(call.fullDetail?.startsWith("path: src/new.ts\nsize: 1.2 KB\nlines: 1\n\ncontent:\n"));
		assert.ok(call.fullDetail?.includes("x".repeat(100)));

		const short = describeToolCall("write", { path: "a.ts", content: "hello" });
		assert.equal(short.detail, "a.ts");
		assert.equal(short.fullDetail?.split("\n").slice(0, 3).join("\n"), "path: a.ts\nsize: 5 B\nlines: 1");
	});

	it("edit 折叠只留文件名，展开内容由结果决定", () => {
		const call = describeToolCall("edit", { path: "src/auth.ts", edits: [{}, {}] });

		assert.equal(call.detail, "auth.ts");
		assert.equal(call.fullDetail, undefined);
	});

	it("bash 直接显示命令，不经过 JSON 转义", () => {
		const call = describeToolCall("bash", { command: 'cd "E:\\Projects" && npm test' });

		assert.equal(call.name, "Bash");
		assert.equal(call.detail, 'cd "E:\\Projects" && npm test');
	});

	it("bash 内联脚本只显示核心，完整命令留给展开", () => {
		const command = `cd E:\\Projects\\demo && python -c " import re,xml.etree.ElementTree as ET s=open('pelican-bike.html',encoding='utf-8').read()"`;
		const call = describeToolCall("bash", { command }, "E:\\Projects\\demo");

		assert.equal(call.detail, "python -c [inline script]");
		assert.equal(call.fullDetail, command);
	});

	it("bash 短命令没有可展开的完整参数", () => {
		const call = describeToolCall("bash", { command: "git status --short" });

		assert.equal(call.detail, "git status --short");
		assert.equal(call.fullDetail, undefined);
	});

	it("摘要压成单行，控制字符与转义序列不会进终端", () => {
		const call = describeToolCall("bash", {
			command: "echo a\necho b\t\x1b[31mred\x1b[0m",
		});

		assert.equal(call.detail, "echo a echo b red");
	});

	it("展开详情同样清掉终端控制字符", () => {
		const call = describeToolCall("write", {
			path: "a.ts",
			content: "\x1b[31mred\x1b[0m\ttext\nsecond",
		});

		assert.equal(call.fullDetail?.includes("\x1b"), false);
		assert.ok(call.fullDetail?.includes("red text"));
	});

	it("find、grep 与 ls 折叠只留目标，展开内容由结果决定", () => {
		const find = describeToolCall("find", { pattern: "*.md", path: ".", limit: 50 });
		assert.equal(find.detail, "*.md");
		assert.equal(find.fullDetail, undefined);
		assert.equal(describeToolCall("find", { pattern: "*.md" }).detail, "*.md");

		const grep = describeToolCall("grep", {
			pattern: "TODO",
			path: "src",
			glob: "*.ts",
			literal: true,
			ignoreCase: true,
			limit: 20,
		});
		assert.equal(grep.detail, "TODO  [in src, *.ts]");
		assert.equal(grep.fullDetail, undefined);
		assert.equal(describeToolCall("grep", { pattern: "TODO" }).detail, "TODO");

		assert.equal(describeToolCall("ls", { path: "." }).detail, "");
		assert.equal(describeToolCall("ls", { path: "." }).fullDetail, undefined);
		assert.equal(describeToolCall("ls", { limit: 10 }).detail, "");
		assert.equal(describeToolCall("ls", { limit: 10 }).fullDetail, undefined);

		const listed = describeToolCall("ls", { path: "server/core", limit: 10 });
		assert.equal(listed.name, "List");
		assert.equal(listed.detail, "server/core");
		assert.equal(listed.group, "list");
		assert.equal(listed.fullDetail, undefined);
	});

	it("长路径折叠保留文件名", () => {
		const path = "E:/Projects/Reins/src/plugins/tools-plugin/very/deep/file.ts";

		const read = describeToolCall("read", { path });
		assert.equal(read.detail, "file.ts");
		assert.equal(read.fullDetail, undefined);

		const list = describeToolCall("ls", { path });
		assert.ok(list.detail.startsWith("…/"));
		assert.ok(list.detail.endsWith("file.ts"));
		assert.equal(list.fullDetail, undefined);
	});

	it("文件类工具的路径带 file:// 链接，相对路径按工作根解析", () => {
		const root = process.cwd();

		const read = describeToolCall("read", { path: "src/a.ts" }, root);
		assert.ok(read.linkTarget?.startsWith("file://"));
		assert.ok(read.linkTarget?.endsWith("/src/a.ts"));

		assert.ok(describeToolCall("write", { path: "a.ts", content: "" }, root).linkTarget);
		assert.ok(describeToolCall("edit", { path: "a.ts", edits: [] }, root).linkTarget);
		assert.ok(describeToolCall("ls", { path: "src" }, root).linkTarget?.endsWith("/src"));

		// 没有工作根时无法可靠解析相对路径；没有目标文本时也不挂链接
		assert.equal(describeToolCall("read", { path: "src/a.ts" }).linkTarget, undefined);
		assert.equal(describeToolCall("ls", { path: "." }, root).linkTarget, undefined);
		assert.equal(describeToolCall("bash", { command: "ls" }, root).linkTarget, undefined);
	});

	it("subagent 折叠只取任务首行，展开显示完整任务", () => {
		const call = describeToolCall("subagent", { task: "do it\nmore" });
		assert.equal(call.detail, "do it");
		assert.equal(call.fullDetail, "do it\nmore");

		const long = describeToolCall("subagent", { task: "x".repeat(200) });
		assert.equal(Array.from(long.detail).length, 121);
		assert.ok(long.detail.endsWith("…"));
		assert.equal(long.fullDetail, "x".repeat(200));
	});

	it("未知工具回退到紧凑 JSON，完整参数在展开里", () => {
		assert.deepEqual(describeToolCall("mcp__fs__list", { path: "a" }), {
			name: "mcp__fs__list",
			detail: '{"path":"a"}',
			fullDetail: '{\n  "path": "a"\n}',
		});
		assert.deepEqual(describeToolCall("mcp__fs__list", {}), { name: "mcp__fs__list", detail: "" });

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
