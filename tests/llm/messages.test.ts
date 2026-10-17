import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assistantText, assistantToolCalls } from "../../src/llm/messages.ts";

describe("助手消息取内容", () => {
	it("文本块之间用空行连接,忽略其它块", () => {
		const text = assistantText({
			role: "assistant",
			content: [
				{ type: "thinking", text: "t" },
				{ type: "text", text: "first" },
				{ type: "toolCall", id: "c", name: "n", arguments: {} },
				{ type: "text", text: "second" },
			],
		});
		assert.equal(text, "first\n\nsecond");
	});

	it("工具调用只取工具块,参数原样", () => {
		const calls = assistantToolCalls({
			role: "assistant",
			content: [
				{ type: "text", text: "doing" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
			],
		});
		assert.deepEqual(calls, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }]);
	});
});
