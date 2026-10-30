import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { presentPlanTool } from "#src/tools/builtin/plan.ts";

function context(plan: string): Parameters<typeof presentPlanTool.execute>[0] {
	return { args: { plan } } as never;
}

describe("计划提交工具", () => {
	it("提交非空计划并告诉模型等待决定", async () => {
		const result = await presentPlanTool.execute(context("# Plan\n\n1. Do it."));

		assert.equal(result.isError, undefined);
		assert.match(result.content, /Plan submitted for review/);
		assert.match(result.content, /wait for the user/);
	});

	it("空计划不产生可审批内容", async () => {
		const result = await presentPlanTool.execute(context("  \n\t"));

		assert.equal(result.isError, true);
		assert.match(result.content, /plan is empty/i);
	});

	it("只读，且只在 Plan 模式的工具清单里出现", () => {
		assert.equal(presentPlanTool.name, "present_plan");
		assert.equal(presentPlanTool.annotations.readOnly, true);
		assert.equal(presentPlanTool.annotations.destructive, false);
	});
});
