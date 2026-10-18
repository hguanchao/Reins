import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cacheHitRate, describeUsage, sumUsage } from "../../src/session/usage.ts";
import type { SessionEntry } from "../../src/session/port.ts";

const T = "2026-01-01T00:00:00Z";

function usage(kind: "turn" | "compact" | "subagent", numbers: { input: number; output: number; total: number }, cost: number | undefined): SessionEntry {
	return {
		type: "usage",
		id: `u-${Math.random()}`,
		parentId: null,
		timestamp: T,
		provider: "p",
		model: "m",
		kind,
		usage: { input: numbers.input, output: numbers.output, cacheRead: 0, cacheWrite: 0, total: numbers.total },
		cost,
	};
}

describe("用量统计", () => {
	it("只认用量条目，其余不动", () => {
		const message: SessionEntry = {
			type: "message",
			id: "m",
			parentId: null,
			timestamp: T,
			message: { role: "user", content: "x" },
		};
		const totals = sumUsage([message, usage("turn", { input: 10, output: 5, total: 15 }, 0.01)]);
		assert.equal(totals.requests, 1);
		assert.equal(totals.input, 10);
		assert.equal(totals.output, 5);
		assert.equal(totals.total, 15);
		assert.equal(totals.cost, 0.01);
	});

	it("压缩与子代理按 kind 计数", () => {
		const totals = sumUsage([
			usage("turn", { input: 1, output: 1, total: 2 }, 0),
			usage("compact", { input: 1, output: 1, total: 2 }, 0),
			usage("subagent", { input: 1, output: 1, total: 2 }, 0),
			usage("subagent", { input: 1, output: 1, total: 2 }, 0),
		]);
		assert.equal(totals.compactions, 1);
		assert.equal(totals.subagents, 2);
	});

	it("一笔单价都没有时金额为空", () => {
		const totals = sumUsage([usage("turn", { input: 1, output: 1, total: 2 }, undefined)]);
		assert.equal(totals.cost, undefined);
		assert.equal(totals.unpriced, 1);
	});

	it("一部分没价的一部分有价的都算清楚", () => {
		const totals = sumUsage([
			usage("turn", { input: 1, output: 1, total: 2 }, undefined),
			usage("turn", { input: 1, output: 1, total: 2 }, 0.02),
		]);
		assert.equal(totals.cost, 0.02);
		assert.equal(totals.unpriced, 1);
	});
});

describe("缓存命中率", () => {
	it("缓存读取占输入侧 token 的比例", () => {
		const entry: SessionEntry = {
			type: "usage",
			id: "u",
			parentId: null,
			timestamp: T,
			provider: "p",
			model: "m",
			kind: "turn",
			usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, total: 105 },
			cost: undefined,
		};

		assert.equal(cacheHitRate(sumUsage([entry])), 0.9);
	});

	it("缓存写入也算输入侧，不命中缓存的新输入越多命中率越低", () => {
		const totals = {
			requests: 1,
			compactions: 0,
			subagents: 0,
			input: 50,
			output: 0,
			cacheRead: 30,
			cacheWrite: 20,
			total: 100,
			cost: undefined,
			unpriced: 1,
		};

		assert.equal(cacheHitRate(totals), 0.3);
	});

	it("没有任何输入侧 token 时返回 0", () => {
		assert.equal(cacheHitRate(sumUsage([])), 0);
	});
});

describe("用量说明", () => {
	it("基础形状：请求数与 token 各项", () => {
		const totals = sumUsage([usage("turn", { input: 10, output: 2, total: 12 }, undefined)]);
		const line = describeUsage(totals);
		assert.match(line, /requests: 1 /);
		assert.match(line, /input: 10/);
		assert.match(line, /total: 12 tokens/);
	});

	it("金额与未计价说明", () => {
		const withCost = describeUsage(sumUsage([usage("turn", { input: 1, output: 1, total: 2 }, 0.5)]));
		assert.match(withCost, /cost: \$0\.5000/);

		const unpriced = describeUsage(
			sumUsage([usage("turn", { input: 1, output: 1, total: 2 }, 0.5), usage("turn", { input: 1, output: 1, total: 2 }, undefined)]),
		);
		assert.match(unpriced, /1 requests unpriced, not counted/);
	});

	it("便宜金额多留几位小数", () => {
		const cheap = describeUsage(sumUsage([usage("turn", { input: 1, output: 1, total: 2 }, 0.000012)]));
		assert.match(cheap, /cost: \$0\.000012/);
	});
});
