import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmMessage } from "../../src/llm/messages.ts";
import { buildTranscriptHistory } from "../../src/tui/history.ts";

describe("会话历史回填", () => {
	it("把用户、助手与工具结果折叠成回合", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: "file contents\nmore",
				isError: false,
			},
			{ role: "user", content: "next" },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const turns = buildTranscriptHistory(messages);

		assert.equal(turns.length, 2);
		assert.equal(turns[0]?.prompt, "hello");
		assert.deepEqual(turns[0]?.response, [
			"hi",
			'· read {"path":"a.ts"}',
			"  done: file contents",
		]);
		assert.equal(turns[1]?.prompt, "next");
		assert.deepEqual(turns[1]?.response, ["done"]);
	});

	it("跳过压缩摘要，前导助手消息归入 earlier conversation", () => {
		const messages: LlmMessage[] = [
			{
				role: "user",
				content:
					"(Summary of the earlier conversation, kept so the work can continue)\n\nsummary",
			},
			{ role: "assistant", content: [{ type: "text", text: "continued" }] },
		];

		const turns = buildTranscriptHistory(messages);

		assert.equal(turns.length, 1);
		assert.equal(turns[0]?.prompt, "(earlier conversation)");
		assert.deepEqual(turns[0]?.response, ["continued"]);
	});
});
