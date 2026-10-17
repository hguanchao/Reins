import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventStream } from "../../src/llm/event-stream.ts";

describe("事件流", () => {
	it("事件按序供迭代,有等待者直接交付", async () => {
		const stream = new EventStream<string, number>((event) => event === "end", () => 42);
		const collected: string[] = [];
		const iterating = (async () => {
			for await (const event of stream) collected.push(event);
		})();
		stream.push("a");
		stream.push("b");
		stream.push("end");
		await iterating;
		assert.deepEqual(collected, ["a", "b", "end"]);
	});

	it("终结事件给出 result,迭代自然收尾", async () => {
		const stream = new EventStream<string, number>((event) => event === "done", () => 7);
		stream.push("done");
		assert.equal(await stream.result(), 7);
	});

	it("close 给出结果并结束迭代", async () => {
		const stream = EventStream.incremental<string, string>();
		const collected: string[] = [];
		const iterating = (async () => {
			for await (const event of stream) collected.push(event);
		})();
		stream.push("x");
		stream.close("closed");
		await iterating;
		assert.deepEqual(collected, ["x"]);
		assert.equal(await stream.result(), "closed");
	});

	it("终结事件之后推入的内容被忽略", async () => {
		const stream = new EventStream<string, number>((event) => event === "t", () => 1);
		stream.push("t");
		stream.push("late");
		const collected: string[] = [];
		for await (const event of stream) collected.push(event);
		assert.deepEqual(collected, ["t"]);
	});

	it("重复 close 不改变结果", async () => {
		const stream = EventStream.incremental<string, string>();
		stream.close("first");
		stream.close("second");
		assert.equal(await stream.result(), "first");
	});
});
