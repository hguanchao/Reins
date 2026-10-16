import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	ContentAccumulator,
	parseToolArguments,
} from "../../../src/llm/adapters/content-accumulator.ts";

describe("内容累积", () => {
	it("文本按出现顺序拼起来", () => {
		const accumulator = new ContentAccumulator();
		accumulator.appendText(0, "你");
		accumulator.appendText(0, "好");
		assert.deepEqual(accumulator.blocks(), [{ type: "text", text: "你好" }]);
	});

	it("同一块在下标上的多次追加合并成一块", () => {
		const accumulator = new ContentAccumulator();
		accumulator.appendText(0, "上面");
		accumulator.appendThinking(1, "想");
		accumulator.appendThinking(1, "一下");
		accumulator.appendText(2, "下面");
		assert.deepEqual(accumulator.blocks(), [
			{ type: "text", text: "上面" },
			{ type: "thinking", text: "想一下" },
			{ type: "text", text: "下面" },
		]);
	});

	it("没有出现过的下标不会留下空位", () => {
		const accumulator = new ContentAccumulator();
		accumulator.appendText(3, "只此一块");
		assert.deepEqual(accumulator.blocks(), [{ type: "text", text: "只此一块" }]);
	});

	it("思考块可以补上签名", () => {
		const accumulator = new ContentAccumulator();
		accumulator.appendThinking(0, "推理过程");
		accumulator.setThinkingSignature(0, "sig-1");
		assert.deepEqual(accumulator.blocks(), [{ type: "thinking", text: "推理过程", signature: "sig-1" }]);
	});

	it("工具调用的标识可以分散多次送达并逐步补齐", () => {
		const accumulator = new ContentAccumulator();
		assert.equal(accumulator.startToolCall(0, "call-1", ""), true);
		// 名称在后续分片里才到
		assert.equal(accumulator.startToolCall(0, "", "read"), false);
		accumulator.appendToolArguments(0, '{"path":');
		accumulator.appendToolArguments(0, '"/tmp/a"}');
		accumulator.finish(0);

		assert.deepEqual(accumulator.blocks(), [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } },
		]);
	});

	it("收尾时把遗留的工具调用一起结算", () => {
		const accumulator = new ContentAccumulator();
		accumulator.startToolCall(1, "call-1", "read");
		accumulator.appendToolArguments(1, '{"path":"a"}');
		accumulator.finishAll();
		assert.deepEqual(accumulator.blocks(), [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
		]);
	});

	it("参数不是合法 JSON 时保留原因而不抛错", () => {
		const accumulator = new ContentAccumulator();
		accumulator.startToolCall(0, "call-1", "read");
		accumulator.appendToolArguments(0, '{"path":');
		accumulator.finish(0);

		const block = accumulator.blocks()[0];
		assert.equal(block?.type, "toolCall");
		assert.deepEqual(block?.type === "toolCall" ? block.arguments : undefined, {});
		assert.match(block?.type === "toolCall" ? (block.argumentsError ?? "") : "", /不是合法 JSON/);
	});

	it("没有参数的工具调用解析成空对象", () => {
		const accumulator = new ContentAccumulator();
		accumulator.startToolCall(0, "call-1", "list");
		accumulator.finish(0);
		assert.deepEqual(accumulator.blocks(), [
			{ type: "toolCall", id: "call-1", name: "list", arguments: {} },
		]);
	});
});

describe("工具参数解析", () => {
	it("空文本解析成空对象", () => {
		assert.deepEqual(parseToolArguments("   "), { arguments: {} });
	});

	it("非对象的 JSON 被拒", () => {
		assert.match(parseToolArguments("[1,2]").argumentsError ?? "", /应当是 JSON 对象/);
		assert.match(parseToolArguments('"x"').argumentsError ?? "", /应当是 JSON 对象/);
	});

	it("合法对象解析成功", () => {
		assert.deepEqual(parseToolArguments('{"a":1}'), { arguments: { a: 1 } });
	});
});
