import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UsageSummary } from "#web/protocol.ts";
import { applyUsageRecorded } from "#web/state/usage.ts";

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
