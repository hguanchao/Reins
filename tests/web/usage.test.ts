import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActivitySummary, UsageSummary } from "#web/protocol.ts";
import { applyActivityRecorded, applyToolDuration, applyUsageRecorded } from "#web/state/usage.ts";

const empty: UsageSummary = {
	requests: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: undefined,
};

/** 快照给的累计值;金额已知的会话。 */
const priced: UsageSummary = {
	requests: 2,
	input: 1_000,
	output: 300,
	cacheRead: 5_000,
	cacheWrite: 200,
	total: 6_500,
	cost: 0.12,
};

describe("用量累计", () => {
	it("事件分项直接累加,合计沿用事件给的工具数", () => {
		const next = applyUsageRecorded(priced, {
			kind: "turn",
			tokens: 1_500,
			input: 1_000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.deepEqual(
			[next.requests, next.input, next.output, next.cacheRead, next.cacheWrite, next.total],
			[3, 2_000, 800, 5_000, 200, 8_000],
		);
	});

	it("两边金额都有才相加", () => {
		const next = applyUsageRecorded(priced, {
			kind: "turn",
			tokens: 100,
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.03,
		});
		assert.equal(next.cost, 0.15);
	});

	it("新事件没配单价时不能抹掉已知的金额", () => {
		const next = applyUsageRecorded(priced, {
			kind: "turn",
			tokens: 100,
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.equal(next.cost, 0.12);
	});

	it("已有金额缺单价时补上新事件的金额", () => {
		const next = applyUsageRecorded({ ...priced, cost: undefined }, {
			kind: "turn",
			tokens: 100,
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.03,
		});
		assert.equal(next.cost, 0.03);
	});

	it("从全零累计起第一笔", () => {
		const next = applyUsageRecorded(empty, {
			kind: "turn",
			tokens: 900,
			input: 500,
			output: 100,
			cacheRead: 200,
			cacheWrite: 100,
			cost: 0.01,
		});
		assert.deepEqual(
			[next.requests, next.total, next.cacheRead, next.cost],
			[1, 900, 200, 0.01],
		);
	});
});

describe("活动累计", () => {
	const empty: ActivitySummary = {
		turns: 0,
		steps: 0,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftCount: 0,
		decodeTokens: 0,
		decodeMs: 0,
	};

	it("主对话请求累进步数与各段耗时", () => {
		const next = applyActivityRecorded({ ...empty, turns: 3 }, {
			kind: "turn",
			llmMs: 2_500,
			ttftMs: 400,
			output: 300,
		});
		assert.deepEqual(
			[next.steps, next.llmMs, next.ttftMs, next.ttftCount, next.decodeTokens, next.decodeMs],
			[1, 2_500, 400, 1, 300, 2_100],
		);
	});

	it("压缩请求不是主对话的一步", () => {
		const next = applyActivityRecorded(empty, { kind: "compact", llmMs: 8_000, output: 500 });
		assert.equal(next.steps, 0);
		assert.equal(next.llmMs, 0);
	});

	it("没记到耗时的请求只进步数", () => {
		const next = applyActivityRecorded(empty, { kind: "turn", output: 100 });
		assert.deepEqual([next.steps, next.llmMs, next.decodeTokens], [1, 0, 0]);
	});

	it("工具耗时累加,负数按零计", () => {
		const one = applyToolDuration(empty, 1_200);
		assert.equal(one.toolMs, 1_200);
		assert.equal(applyToolDuration(one, -5).toolMs, 1_200);
	});
});
