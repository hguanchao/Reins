import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resultDetail, resultMetric } from "../../src/tools/result-summary.ts";

describe("工具结果呈现", () => {
	it("read 展开为带行号的文件内容", () => {
		assert.deepEqual(resultDetail("read", "a\nb", { startLine: 10, endLine: 11, totalLines: 100 }), {
			text: "10  a\n11  b",
			kind: "file",
		});
		assert.deepEqual(resultDetail("read", "a\nb"), { text: "1  a\n2  b", kind: "file" });
		assert.deepEqual(
			resultDetail("read", "a\nb\n\n[showing lines 5-6 of 10; continue]"),
			{ text: "5  a\n6  b", kind: "file" },
		);
		assert.deepEqual(resultDetail("read", "a.txt is empty", { lines: 0 }), {
			text: "(empty)",
			kind: "text",
		});
	});

	it("read 的压缩 JSON 按缩进展开", () => {
		const compact = '{"name":"reins","count":2}';
		assert.deepEqual(
			resultDetail("read", compact, {
				path: "package.json",
				startLine: 1,
				endLine: 1,
				totalLines: 1,
				text: compact,
			}),
			{
				text: '1  {\n2    "name": "reins",\n3    "count": 2\n4  }',
				kind: "file",
			},
		);

		// 历史回放没有结构化详情，同样用折叠行的文件名判断
		assert.deepEqual(resultDetail("read", '{"a":1}', undefined, "a.json"), {
			text: '1  {\n2    "a": 1\n3  }',
			kind: "file",
		});
	});

	it("已经是多行或不是 JSON 时不重排，行号保持原样", () => {
		const formatted = '{\n  "a": 1\n}';
		const detail = resultDetail("read", formatted, {
			path: "a.json",
			startLine: 1,
			endLine: 3,
			totalLines: 3,
			text: formatted,
		});
		assert.deepEqual(detail, { text: "1  {\n2    \"a\": 1\n3  }", kind: "file" });

		assert.deepEqual(resultDetail("read", '{"a":1}', { path: "a.txt" }), {
			text: '1  {"a":1}',
			kind: "file",
		});
		// 读了一半的 JSON 解析不了，保持原样而不是丢掉内容
		assert.deepEqual(resultDetail("read", '{"a":', { path: "a.json" }), {
			text: '1  {"a":',
			kind: "file",
		});
	});

	it("read 长文件只显示前五行与后三行", () => {
		const content = Array.from({ length: 185 }, (_, index) => `line ${index + 1}`).join("\n");
		const detail = resultDetail("read", content, { startLine: 1, endLine: 185, totalLines: 185 });
		const lines = detail?.text.split("\n") ?? [];

		assert.equal(lines.length, 9);
		assert.equal(lines[0], "  1  line 1");
		assert.equal(lines[4], "  5  line 5");
		assert.equal(lines[5], "     …");
		assert.equal(lines[6], "183  line 183");
		assert.equal(lines[8], "185  line 185");
		assert.equal(detail?.text.includes("line 100"), false);
	});

	it("落盘结果不按文件行号排版", () => {
		const spill =
			"a\nb\n\n… (100 characters omitted in the middle) …\n\ny\n\n[the full result is 500 characters; written to /tmp/x, read it back line by line]";

		assert.deepEqual(resultDetail("read", spill, { startLine: 1, endLine: 2, totalLines: 2 }), {
			text: spill,
			kind: "text",
		});
	});

	it("有完整正文时忽略落盘预览", () => {
		const body = Array.from({ length: 185 }, (_, index) => `line ${index + 1}`).join("\n");
		const spill = `${body.slice(0, 100)}\n\n… (500 characters omitted in the middle) …\n\n[the full result is 8758 characters; written to /tmp/x, read it back line by line]`;

		const detail = resultDetail("read", spill, {
			startLine: 1,
			endLine: 185,
			totalLines: 185,
			text: body,
		});

		assert.equal(detail?.kind, "file");
		assert.ok(detail?.text.includes("  1  line 1"));
		assert.ok(detail?.text.includes("     …"));
		assert.ok(detail?.text.includes("185  line 185"));
		assert.equal(detail?.text.includes("the full result"), false);
	});

	it("diff 在 hunk 之间省略未改动行", () => {
		const spaced = [
			"@@ line 1 @@",
			"  one",
			"- old",
			"+ new",
			"@@ line 10 @@",
			"  later",
		].join("\n");
		const spacedText = resultDetail("edit", "Updated a.ts", { diff: spaced })?.text ?? "";
		assert.ok(spacedText.includes("… 7 unchanged lines"));
		assert.ok(spacedText.includes("one"));
		assert.ok(spacedText.includes("old"));
		assert.ok(spacedText.includes("new"));
		assert.ok(spacedText.includes("later"));

		const single = ["@@ line 1 @@", "  one", "@@ line 3 @@", "  three"].join("\n");
		assert.ok(
			resultDetail("edit", "Updated a.ts", { diff: single })?.text.includes("… 1 unchanged line"),
		);

		const adjacent = ["@@ line 1 @@", "  one", "@@ line 2 @@", "  two"].join("\n");
		const adjacentText = resultDetail("edit", "Updated a.ts", { diff: adjacent })?.text ?? "";
		assert.ok(adjacentText.split("\n").some((line) => line.trim() === "…"));
		assert.equal(adjacentText.includes("unchanged"), false);
	});

	it("list/find/grep 展开为文本结果", () => {
		assert.deepEqual(resultDetail("ls", "- a.ts\n- b.ts"), {
			text: "- a.ts\n- b.ts",
			kind: "text",
		});
		assert.deepEqual(resultDetail("find", "src/a.ts"), { text: "src/a.ts", kind: "text" });
		assert.deepEqual(resultDetail("grep", "src/a.ts:1: TODO"), {
			text: "src/a.ts:1: TODO",
			kind: "text",
		});
	});

	it("edit 与 write 展开为带行号的 diff，hunk 头不进入正文", () => {
		const editDiff = "@@ line 1 @@\n- old\n+ new";
		// 起点已由行号列说明，`@@ line N @@` 不再铺在正文里
		assert.deepEqual(resultDetail("edit", "Updated a.ts", { diff: editDiff }), {
			text: "1 - old\n1 + new",
			kind: "diff",
		});
		assert.deepEqual(resultDetail("edit", "Updated a.ts\n\n- old\n+ new"), {
			text: "Updated a.ts\n1 - old\n1 + new",
			kind: "diff",
		});
		assert.deepEqual(resultDetail("write", "Created a.ts", { diff: editDiff }), {
			text: "1 - old\n1 + new",
			kind: "diff",
		});
		assert.deepEqual(resultDetail("write", "Created a.ts"), {
			text: "Created a.ts",
			kind: "text",
		});
	});

	it("多 hunk 之间用省略行连接，起始行号仍取自 hunk 头", () => {
		const two = "@@ line 10 @@\n- old\n+ new\n@@ line 40 @@\n  later";
		assert.deepEqual(resultDetail("edit", "Updated a.ts", { diff: two }), {
			text: "10 - old\n10 + new\n   … 29 unchanged lines\n40   later",
			kind: "diff",
		});
	});

	it("展开结果清掉终端控制字符，其他工具不接管展开", () => {
		assert.deepEqual(resultDetail("ls", "\x1b[31mred\x1b[0m\ttext"), {
			text: "red text",
			kind: "text",
		});
		assert.equal(resultDetail("bash", "output"), undefined);
		assert.equal(resultDetail("read", ""), undefined);
	});
});

describe("工具结果指标", () => {
	it("read 显示行数或已读范围", () => {
		assert.equal(resultMetric("read", { startLine: 1, endLine: 120, totalLines: 120 }, ""), "120 lines");
		assert.equal(resultMetric("read", { startLine: 88, endLine: 127, totalLines: 400 }, ""), "88-127 of 400");
		assert.equal(resultMetric("read", { lines: 0 }, "a.txt is empty"), "empty");
	});

	it("read 历史回放时从结果文本估算", () => {
		assert.equal(resultMetric("read", undefined, "one\ntwo\nthree"), "3 lines");
		assert.equal(resultMetric("read", undefined, "one\ntwo\n"), "2 lines");
		assert.equal(resultMetric("read", undefined, "one\n\n[showing lines 1-500 of 900; continue]"), "1-500 of 900");
	});

	it("write 显示创建/覆盖与大小", () => {
		assert.equal(resultMetric("write", { bytes: 1234, created: true }, ""), "created, 1.2 KB");
		assert.equal(resultMetric("write", { bytes: 5, created: false }, ""), "overwrote, 5 B");
		assert.equal(resultMetric("write", undefined, "Created a.ts with 42 bytes"), "created, 42 B");
	});

	it("edit 显示增删行数或改动条数", () => {
		const diff = "@@ line 1 @@\n  keep\n- old\n+ new\n+ extra";
		assert.equal(resultMetric("edit", { changed: true, diff, editCount: 1 }, ""), "+2/-1");
		assert.equal(resultMetric("edit", { changed: false }, "a.ts is unchanged"), "unchanged");
		assert.equal(resultMetric("edit", { changed: true, editCount: 2 }, ""), "2 edits");
		assert.equal(resultMetric("edit", undefined, "Updated a.ts: 1 edits applied\n\n@@ line 1 @@\n- x\n+ y"), "+1/-1");
	});

	it("grep 与 find 显示匹配数或文件数", () => {
		assert.equal(resultMetric("grep", { matched: 5 }, ""), "5 matches");
		assert.equal(resultMetric("grep", { matched: 1 }, ""), "1 match");
		assert.equal(resultMetric("grep", {}, "No matches for \"x\" (3 files checked)"), "no matches");
		assert.equal(resultMetric("find", { matched: 12 }, ""), "12 files");
		assert.equal(resultMetric("find", undefined, "a.ts\nb.ts\n\n[hit the limit of 2]"), "2 files");
	});

	it("ls 显示条目数", () => {
		assert.equal(resultMetric("ls", { total: 18 }, ""), "18 entries");
		assert.equal(resultMetric("ls", { total: 1 }, ""), "1 entry");
		assert.equal(resultMetric("ls", { total: 0 }, "src is empty"), "empty");
		assert.equal(resultMetric("ls", undefined, "a/\nb.ts"), "2 entries");
	});

	it("subagent 显示步数，其他工具没有指标", () => {
		assert.equal(resultMetric("subagent", { steps: 7 }, ""), "7 steps");
		assert.equal(resultMetric("bash", { exitCode: 0 }, ""), undefined);
		assert.equal(resultMetric("mcp__fs__list", { total: 1 }, ""), undefined);
	});
});
