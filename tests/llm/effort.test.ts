import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampEffort, isReasoningEffort, providerEffortValue, supportedEfforts } from "../../src/llm/effort.ts";

describe("思考等级", () => {
	it("isReasoningEffort 认真实等级,不认 off", () => {
		assert.equal(isReasoningEffort("low"), true);
		assert.equal(isReasoningEffort("max"), true);
		assert.equal(isReasoningEffort("off"), false);
		assert.equal(isReasoningEffort("high"), true);
	});

	it("supportedEfforts:不支持思考的模型只有 off", () => {
		assert.deepEqual(supportedEfforts(false, {}), ["off"]);
	});

	it("supportedEfforts:显式 null 的等级不支持,其余按支持", () => {
		assert.deepEqual(supportedEfforts(true, { low: null, high: "custom" }), [
			"off",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("clampEffort:off 与不支持思考都返回 undefined", () => {
		assert.equal(clampEffort("off", true, {}), undefined);
		assert.equal(clampEffort("high", false, {}), undefined);
	});

	it("clampEffort:请求的等级支持时原样", () => {
		assert.equal(clampEffort("high", true, {}), "high");
	});

	it("clampEffort:先往下找再往上找", () => {
		// 模型支持到 medium:请求 high 降到 medium
		assert.equal(clampEffort("high", true, { high: null, xhigh: null, max: null }), "medium");
		// low 到 max 都不支持:nothing
		assert.equal(clampEffort("medium", true, { low: null, medium: null, high: null, xhigh: null, max: null }), undefined);
		// 请求 low 但 low 不支持,向上落到 medium
		assert.equal(clampEffort("low", true, { low: null }), "medium");
	});

	it("providerEffortValue:写了映射用映射值,没写透传等级名", () => {
		assert.equal(providerEffortValue("high", { high: "thinking_budget_max" }), "thinking_budget_max");
		assert.equal(providerEffortValue("high", {}), "high");
	});
});
