import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentAccumulator, parseToolArguments } from "../../../src/llm/adapters/content-accumulator.ts";

describe("内容累积器", () => {
	it("文本按下标拼接,乱序下标按出现顺序排列", () => {
		const blocks = new ContentAccumulator();
		blocks.appendText(0, "Hello");
		blocks.appendText(0, " world");
		blocks.appendText(2, "!");
		blocks.appendText(1, "second");
		assert.deepEqual(
			blocks.blocks().filter((block) => block.type === "text").map((block) => (block as { text: string }).text),
			["Hello world", "second", "!"],
		);
	});

	it("思考块拼接并保留签名", () => {
		const blocks = new ContentAccumulator();
		blocks.appendThinking(0, "think ");
		blocks.setThinkingSignature(0, "sig-1");
		blocks.appendThinking(0, "more");
		const [thinking] = blocks.blocks();
		assert.deepEqual(thinking, { type: "thinking", text: "think more", signature: "sig-1" });
	});

	it("setThinkingSignature 对非思考块无效", () => {
		const blocks = new ContentAccumulator();
		blocks.appendText(0, "t");
		blocks.setThinkingSignature(0, "sig");
		assert.deepEqual(blocks.blocks(), [{ type: "text", text: "t" }]);
	});

	it("工具调用:startToolCall 首次为真,重复返回假并补齐", () => {
		const blocks = new ContentAccumulator();
		assert.equal(blocks.startToolCall(0, "id1", "read"), true);
		assert.equal(blocks.startToolCall(0, "", "read"), false); // 名称已在,空串不覆盖
		const [call] = blocks.blocks();
		assert.deepEqual(call, { type: "toolCall", id: "id1", name: "read", arguments: {} });
	});

	it("工具参数:JSON 分片在收尾时拼接解析", () => {
		const blocks = new ContentAccumulator();
		blocks.startToolCall(0, "id1", "write");
		blocks.appendToolArguments(0, '{"path":');
		blocks.appendToolArguments(0, '"a.ts"}');
		blocks.finish(0);
		assert.deepEqual(blocks.blocks(), [{ type: "toolCall", id: "id1", name: "write", arguments: { path: "a.ts" } }]);
	});

	it("参数不是合法 JSON 时错误记在块上", () => {
		const blocks = new ContentAccumulator();
		blocks.startToolCall(0, "id1", "write");
		blocks.appendToolArguments(0, '{"path": ');
		blocks.finish(0);
		const call = blocks.blocks()[0] as { argumentsError?: string };
		assert.match(call.argumentsError ?? "", /not valid JSON/);
	});

	it("参数解析为非对象时也有说明", () => {
		const blocks = new ContentAccumulator();
		blocks.startToolCall(0, "id1", "write");
		blocks.appendToolArguments(0, "[1,2]");
		blocks.finish(0);
		const call = blocks.blocks()[0] as { argumentsError?: string };
		assert.equal(call.argumentsError, "tool arguments must be a JSON object");
	});

	it("finishAll 收掉所有工具块;对非工具块无操作", () => {
		const blocks = new ContentAccumulator();
		blocks.appendText(0, "answer");
		blocks.startToolCall(1, "a", "r");
		blocks.startToolCall(2, "b", "w");
		blocks.appendToolArguments(1, '{"x":1}');
		blocks.appendToolArguments(2, '{"y":2}');
		blocks.finishAll();
		assert.deepEqual(
			blocks.blocks(),
			[
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "a", name: "r", arguments: { x: 1 } },
				{ type: "toolCall", id: "b", name: "w", arguments: { y: 2 } },
			],
		);
	});

	it("isEmpty 与无参数默认空对象", () => {
		const blocks = new ContentAccumulator();
		assert.equal(blocks.isEmpty(), true);
		blocks.startToolCall(0, "id", "t");
		assert.equal(blocks.isEmpty(), false);
		blocks.finish(0); // 没有累积任何参数
		assert.deepEqual(blocks.blocks(), [{ type: "toolCall", id: "id", name: "t", arguments: {} }]);
	});
});

describe("参数解析", () => {
	it("空白按空对象算", () => {
		assert.deepEqual(parseToolArguments("   "), { arguments: {} });
	});

	it("对象正常解析", () => {
		assert.deepEqual(parseToolArguments('{"a":1}'), { arguments: { a: 1 } });
	});

	it("数组与非对象报错不抛", () => {
		assert.equal(parseToolArguments("[1]").argumentsError, "tool arguments must be a JSON object");
		assert.equal(parseToolArguments("42").argumentsError, "tool arguments must be a JSON object");
		assert.match(parseToolArguments("{bad").argumentsError ?? "", /not valid JSON/);
	});
});
