import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeToolLine, isRunningTool } from "#src/tui/transcript/model.ts";

describe("工具行构造", () => {
	it("带上调用 id 与有值的可选字段", () => {
		const line = describeToolLine("read", { path: "README.md" }, "c1");
		assert.equal(line.kind, "tool");
		assert.equal(line.callId, "c1");
		assert.equal(line.name, "Read");
		assert.equal(line.detail, "README.md");
		assert.equal(line.group, "read");
		// 不带值的可选字段不写入，保持对象形状最小
		assert.equal("fullDetail" in line, false);
	});
});

describe("运行状态判定", () => {
	const base = { kind: "tool", name: "Bash", detail: "npm test", startedAt: 1000 } as const;

	it("有起点且没有结果时算运行中", () => {
		assert.equal(isRunningTool({ ...base }), true);
	});

	it("拿到结果后不再算运行中，即使起点还在", () => {
		assert.equal(isRunningTool({ ...base, result: "ok" }), false);
		assert.equal(isRunningTool({ ...base, isError: true }), false);
	});

	it("历史回填的行没有起点，一律按已结束处理", () => {
		assert.equal(isRunningTool({ kind: "tool", name: "Read", detail: "a.ts" }), false);
	});
});
