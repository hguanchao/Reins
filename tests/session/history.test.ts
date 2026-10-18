import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { historyFromEntries } from "../../src/session/history.ts";
import type { SessionEntry } from "../../src/session/port.ts";

const STAMP = "2026-10-18T10:00:00.000Z";
const AT = Date.parse(STAMP);

describe("会话历史整理", () => {
	it("把消息拆成用户、思考、回答与工具项，并保留原时间", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: STAMP,
				message: { role: "user", content: "hello" },
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: STAMP,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", text: "hmm" },
						{ type: "text", text: "answer" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
					],
				},
			},
			{
				type: "message",
				id: "3",
				parentId: "2",
				timestamp: STAMP,
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: "file body",
					isError: false,
				},
			},
			{
				type: "compaction",
				id: "4",
				parentId: "3",
				timestamp: STAMP,
				summary: "summary",
				covered: ["1", "2", "3"],
				provider: "p",
				model: "m",
				tokensBefore: 1_000,
				usage: undefined,
			},
		];

		const items = historyFromEntries(entries);
		assert.deepEqual(items.map((item) => item.kind), ["user", "thinking", "assistant", "tool", "system"]);
		assert.deepEqual(items[0], { kind: "user", text: "hello", at: AT });
		assert.deepEqual(items[1], { kind: "thinking", text: "hmm", at: AT, elapsedMs: 0 });
		assert.deepEqual(items[2], { kind: "assistant", text: "answer", at: AT });
		assert.deepEqual(items[3], {
			kind: "tool",
			name: "read",
			args: { path: "a.ts" },
			output: "file body",
			isError: false,
			at: AT,
		});
		assert.ok(items[4]?.kind === "system" && items[4].text.includes("1000 tokens"));
	});

	it("没有配对的工具结果仍出现，参数退化为空对象", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: STAMP,
				message: {
					role: "toolResult",
					toolCallId: "missing",
					toolName: "bash",
					content: "output",
					isError: true,
				},
			},
		];
		const items = historyFromEntries(entries);
		assert.equal(items.length, 1);
		assert.ok(items[0]?.kind === "tool");
		assert.deepEqual(items[0].args, {});
		assert.equal(items[0].isError, true);
	});

	it("提示词、模型变更与用量不进入对话内容", () => {
		const entries: SessionEntry[] = [
			{
				type: "system",
				id: "1",
				parentId: null,
				timestamp: STAMP,
				sections: { base: "prompt" },
			},
			{
				type: "model_change",
				id: "2",
				parentId: "1",
				timestamp: STAMP,
				provider: "p",
				model: "m",
			},
			{
				type: "usage",
				id: "3",
				parentId: "2",
				timestamp: STAMP,
				provider: "p",
				model: "m",
				kind: "turn",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
				cost: undefined,
			},
		];
		assert.deepEqual(historyFromEntries(entries), []);
	});
});
