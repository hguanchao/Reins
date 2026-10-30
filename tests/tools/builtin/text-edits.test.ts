import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planTextEdits } from "#src/tools/builtin/text-edits.ts";

describe("文本替换规划", () => {
	it("多处不重叠的替换按原文位置应用", () => {
		const result = planTextEdits("alpha beta gamma", [
			{ oldText: "alpha", newText: "one" },
			{ oldText: "gamma", newText: "three" },
		]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.plan.updated, "one beta three");
		assert.deepEqual(result.plan.located.map((edit) => edit.source), [1, 2]);
		assert.match(result.plan.diff, /- alpha/);
		assert.match(result.plan.diff, /\+ one/);
	});

	it("同一位置重叠时拒绝，并报原始序号", () => {
		const result = planTextEdits("abcdef", [
			{ oldText: "abc", newText: "x" },
			{ oldText: "cde", newText: "y" },
		]);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /Edits 1 and 2 overlap/);
	});

	it("oldText 不唯一时拒绝", () => {
		const result = planTextEdits("x x", [{ oldText: "x", newText: "y" }]);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /appears more than once/);
	});

	it("找不到 oldText 时拒绝", () => {
		const result = planTextEdits("abc", [{ oldText: "z", newText: "y" }]);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /was not found/);
	});

	it("空 oldText 拒绝，避免变成在开头插入", () => {
		const result = planTextEdits("abc", [{ oldText: "", newText: "x" }]);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /empty oldText/);
	});

	it("没有编辑项时拒绝", () => {
		const result = planTextEdits("abc", []);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /At least one edit/);
	});

	it("内容不变时 updated 与原文一致", () => {
		const result = planTextEdits("abc", [{ oldText: "b", newText: "b" }]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.plan.updated, "abc");
	});
});
