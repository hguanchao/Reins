import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resultMetric } from "../../src/tools/result-metric.ts";

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
		assert.equal(
			resultMetric("edit", undefined, "Updated a.ts: 1 edits applied\n\n@@ line 1 @@\n- x\n+ y"),
			"+1/-1",
		);
	});

	it("grep 与 find 显示匹配数或文件数", () => {
		assert.equal(resultMetric("grep", { matched: 5 }, ""), "5 matches");
		assert.equal(resultMetric("grep", { matched: 1 }, ""), "1 match");
		assert.equal(resultMetric("grep", {}, 'No matches for "x" (3 files checked)'), "no matches");
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
