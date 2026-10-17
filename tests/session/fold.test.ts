import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldEntries, SessionFolder, summaryMessage } from "../../src/session/fold.ts";
import type { SessionEntry } from "../../src/session/port.ts";
import type { LlmMessage } from "../../src/llm/messages.ts";

const T = "2026-01-01T00:00:00Z";

function messageEntry(id: string, message: LlmMessage, parentId: string | null = null): SessionEntry {
	return { type: "message", id, parentId, timestamp: T, message };
}

function systemEntry(id: string, sections: Record<string, string | null>): SessionEntry {
	return { type: "system", id, parentId: null, timestamp: T, sections };
}

function usageEntry(id: string): SessionEntry {
	return {
		type: "usage",
		id,
		parentId: null,
		timestamp: T,
		provider: "p",
		model: "m",
		kind: "turn",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		cost: undefined,
	};
}

describe("会话折叠", () => {
	it("消息按顺序进上下文，用量条目不进", () => {
		const state = foldEntries([
			messageEntry("a", { role: "user", content: "hi" }),
			usageEntry("u"),
			messageEntry("b", { role: "assistant", content: [{ type: "text", text: "yo" }] }),
		]);
		assert.deepEqual(state.messageIds, ["a", "b"]);
		assert.deepEqual(state.messages, [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "yo" }] },
		]);
		assert.equal(state.model, undefined);
	});

	it("system 条目:节覆盖写、null 移除、工具增删替换", () => {
		const folder = new SessionFolder();
		folder.add(systemEntry("s1", { toolset: "full", extra: "x" }));
		folder.add({
			type: "system",
			id: "s2",
			parentId: null,
			timestamp: T,
			sections: { extra: null },
			toolsAdded: [{ name: "read", description: "d", parameters: {} }],
		});
		folder.add({
			type: "system",
			id: "s3",
			parentId: null,
			timestamp: T,
			sections: {},
			toolsAdded: [{ name: "read", description: "d2", parameters: {} }],
		});

		const state = folder.state();
		// extra 被 null 移除；toolset 保留
		assert.deepEqual(state.sections, { toolset: "full" });
		// 同名工具被后一条替换，只剩一个
		assert.deepEqual(
			state.tools.map((tool) => `${tool.name}:${tool.description}`),
			["read:d2"],
		);

		folder.add(systemEntry("s4", { toolset: null }));
		assert.deepEqual(folder.state().sections, {});
	});

	it("增量折叠与从头折叠结果一致", () => {
		const entries: SessionEntry[] = [
			systemEntry("s1", { toolset: "builtin" }),
			messageEntry("m1", { role: "user", content: "a" }),
		];
		const folded = foldEntries(entries);

		const incremental = new SessionFolder();
		for (const entry of entries) incremental.add(entry);
		assert.deepEqual(incremental.state(), folded);
	});

	it("模型与思考等级切换", () => {
		const state = foldEntries([
			{ type: "model_change", id: "k1", parentId: null, timestamp: T, provider: "p", model: "m" },
			{ type: "effort_change", id: "k2", parentId: null, timestamp: T, effort: "high" },
		]);
		assert.deepEqual(state.model, { provider: "p", model: "m" });
		assert.equal(state.effort, "high");
	});

	it("压缩:被覆盖的消息退出，摘要排最前，未覆盖的排在摘要之后", () => {
		const state = foldEntries([
			messageEntry("m1", { role: "user", content: "one" }),
			messageEntry("m2", { role: "user", content: "two" }),
			messageEntry("m3", { role: "user", content: "three" }),
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: T,
				summary: "the summary",
				covered: ["m1", "m2"],
				provider: "p",
				model: "m",
				tokensBefore: 100,
				usage: undefined,
			},
		]);

		// m1、m2 被摘要替代；摘要壳在最前，m3 留下
		assert.equal(state.messages.length, 2);
		assert.match((state.messages[0] as { content: string }).content, /Summary of the earlier conversation/);
		assert.match((state.messages[0] as { content: string }).content, /the summary/);
		assert.equal((state.messages[1] as { content: string }).content, "three");
	});
});

describe("摘要外壳", () => {
	it("说明这是先前对话的替代品", () => {
		const message = summaryMessage("handover");
		assert.equal(message.role, "user");
		assert.match(message.content, /^\(Summary of the earlier conversation/);
		assert.ok(message.content.includes("handover"));
	});
});
