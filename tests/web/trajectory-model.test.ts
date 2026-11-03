import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeTurns } from "#web/trajectory/trajectory-model.ts";
import type { Line } from "#web/transcript/lines.ts";

const tool = (callId: string, durationMs: number, isError = false): Line => ({
	kind: "tool",
	callId,
	name: "read",
	args: undefined,
	running: false,
	isError,
	durationMs,
	summary: "ok",
	detail: "",
	content: undefined,
	details: undefined,
});

describe("轨迹轮次汇总", () => {
	it("用户消息开新轮，回答取最后一段，工具耗时累加", () => {
		const turns = summarizeTurns([
			{ kind: "user", text: "修一下登录\n顺便看看测试" },
			{ kind: "thinking", text: "想想", open: false },
			tool("t1", 120),
			tool("t2", 80, true),
			{ kind: "assistant", text: "第一段", open: false },
			{ kind: "assistant", text: "改好了", open: false },
		]);
		assert.deepEqual(turns, [
			{
				turn: 1,
				user: "修一下登录",
				assistant: "改好了",
				toolCount: 2,
				failedTools: 1,
				durationMs: 200,
			},
		]);
	});

	it("没有用户消息的输出归入第一轮，空输入保留", () => {
		const turns = summarizeTurns([
			tool("t1", 30),
			{ kind: "assistant", text: "直接回答", open: false },
		]);
		assert.equal(turns.length, 1);
		assert.equal(turns[0]?.turn, 1);
		assert.equal(turns[0]?.user, "");
		assert.equal(turns[0]?.assistant, "直接回答");
	});

	it("多轮按用户消息切分", () => {
		const turns = summarizeTurns([
			{ kind: "user", text: "一" },
			{ kind: "assistant", text: "答一", open: false },
			{ kind: "user", text: "二" },
			{ kind: "assistant", text: "答二", open: false },
		]);
		assert.deepEqual(
			turns.map((turn) => [turn.turn, turn.user, turn.assistant]),
			[
				[1, "一", "答一"],
				[2, "二", "答二"],
			],
		);
	});

	it("空会话没有轮次", () => {
		assert.deepEqual(summarizeTurns([]), []);
	});
});
