import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assistantText, assistantToolCalls, userImages, userText } from "../../src/llm/messages.ts";

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

describe("用户消息取内容", () => {
	it("字符串内容原样返回,没有图片", () => {
		const message = { role: "user" as const, content: "hello" };
		assert.equal(userText(message), "hello");
		assert.deepEqual(userImages(message), []);
	});

	it("块数组里文本用空行连接,图片单独取出", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const message = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: "first" },
				image,
				{ type: "text" as const, text: "second" },
			],
		};
		assert.equal(userText(message), "first\n\nsecond");
		assert.deepEqual(userImages(message), [image]);
	});
});
