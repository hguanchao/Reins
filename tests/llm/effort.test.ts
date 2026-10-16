import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampEffort, providerEffortValue, supportedEfforts } from "../../src/llm/effort.ts";

describe("思考等级的收敛", () => {
	it("不声明思考能力的模型只支持 off", () => {
		assert.deepEqual(supportedEfforts(false, {}), ["off"]);
		assert.equal(clampEffort("high", false, {}), undefined);
	});

	it("声明了思考能力却没给映射时，等级原样可用", () => {
		assert.deepEqual(supportedEfforts(true, {}), ["off", "low", "medium", "high", "xhigh", "max"]);
		assert.equal(clampEffort("high", true, {}), "high");
	});

	it("显式标为 null 的等级不可用，未知等级同样不可用", () => {
		assert.deepEqual(supportedEfforts(true, { xhigh: null, max: null }), [
			"off",
			"low",
			"medium",
			"high",
		]);
	});

	it("请求不可用的等级时先往低处找", () => {
		assert.equal(clampEffort("high", true, { high: null }), "medium");
		assert.equal(clampEffort("max", true, { high: null, xhigh: null, max: null }), "medium");
	});

	it("低处都不可用时才往高处找", () => {
		assert.equal(clampEffort("low", true, { low: null, medium: null }), "high");
	});

	it("off 与不支持思考都收敛为 undefined", () => {
		assert.equal(clampEffort("off", true, {}), undefined);
		assert.equal(clampEffort("off", false, {}), undefined);
	});
});

describe("等级在端点那边的取值", () => {
	it("有映射时用映射值", () => {
		assert.equal(providerEffortValue("high", { high: "HIGH" }), "HIGH");
	});

	it("没有映射时透传等级名", () => {
		assert.equal(providerEffortValue("medium", {}), "medium");
	});
});
