import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	groupKindOf,
	groupLabel,
	runningGroupLabel,
} from "../../../src/plugins/tui-plugin/transcript-group.ts";

describe("工具分组", () => {
	it("按工具名归类", () => {
		assert.equal(groupKindOf("Read"), "file");
		assert.equal(groupKindOf("grep"), "search");
		assert.equal(groupKindOf("list_dir"), "dir");
		assert.equal(groupKindOf("webfetch"), "web");
		assert.equal(groupKindOf("bash"), undefined);
	});

	it("定型标签按首次出现排序并统计失败", () => {
		const result = groupLabel([
			{ name: "read" },
			{ name: "read", isError: true },
			{ name: "grep" },
		]);
		assert.equal(result.label, "Read 2 files, Searched 1 pattern");
		assert.equal(result.failed, 1);
	});

	it("运行中标签用进行时", () => {
		assert.equal(
			runningGroupLabel([{ name: "read" }, { name: "grep" }, { name: "read" }]),
			"Reading 2 files, Searching 1 pattern",
		);
	});
});
