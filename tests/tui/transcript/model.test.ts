import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeToolLine } from "../../../src/tui/transcript/model.ts";

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
