import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withPluginDisabled } from "#src/plugins/disabled.ts";

describe("插件禁用清单", () => {
	it("禁用时去重并排序，启用时移除", () => {
		assert.deepEqual(withPluginDisabled(["b", "a", "b"], "c", true), ["a", "b", "c"]);
		assert.deepEqual(withPluginDisabled(["b", "a"], "a", false), ["b"]);
	});

	it("重复启用不会产生重复项", () => {
		assert.deepEqual(withPluginDisabled(["a"], "a", false), []);
	});
});
