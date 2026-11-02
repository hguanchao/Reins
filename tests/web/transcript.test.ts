import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendToLast, groupToolRuns, linesFromEntries, sealStreaming, updateTool, type Line } from "#web/transcript/lines.ts";

/**
 * 会话流状态逻辑的契约:增量拼接到哪一行、回合边界怎么封口、工具结果怎么回填。
 * 这些是纯函数,渲染层只消费它们的产物。
 */

function assistant(text: string, open = false): Line {
	return { kind: "assistant", text, open };
}

describe("appendToLast 增量拼接", () => {
	it("没有可接的行时新开一行", () => {
		const next = appendToLast([], "assistant", "你好");
		assert.deepEqual(next, [{ kind: "assistant", text: "你好", open: true }]);
	});

	it("接进最后一行未封口的同 kind 行", () => {
		const next = appendToLast([assistant("第一段", true)], "assistant", "第二段");
		assert.deepEqual(next, [assistant("第一段第二段", true)]);
	});

	it("跨过其他行也只接最后一个未封口的同 kind 行", () => {
		const lines: Line[] = [
			{ kind: "thinking", text: "想法", open: true },
			assistant("回答", true),
		];
		const next = appendToLast(lines, "thinking", "续");
		assert.deepEqual(next, [{ kind: "thinking", text: "想法续", open: true }, assistant("回答", true)]);
	});

	it("最后一行已封口时不接,新开一行", () => {
		const next = appendToLast([assistant("上一回合", false)], "assistant", "新回合");
		assert.deepEqual(next, [assistant("上一回合", false), assistant("新回合", true)]);
	});
});

describe("回合边界", () => {
	it("sealStreaming 封住所有流式行,不影响其他行", () => {
		const sealed = sealStreaming([
			{ kind: "thinking", text: "a", open: true },
			assistant("b", true),
			{ kind: "user", text: "u" },
		]);
		assert.deepEqual(sealed, [
			{ kind: "thinking", text: "a", open: false },
			assistant("b", false),
			{ kind: "user", text: "u" },
		]);
	});
});

describe("工具行回填", () => {
	const toolLine: Line = {
		kind: "tool",
		callId: "c1",
		name: "read",
		args: undefined,
		running: true,
		isError: false,
		durationMs: undefined,
		summary: undefined,
		detail: "",
		content: undefined,
		details: undefined,
	};

	it("按 callId 找到并改写", () => {
		const next = updateTool([toolLine], "c1", (line) => ({ ...line, running: false, summary: "done" }));
		assert.equal(next[0].kind === "tool" && next[0].summary, "done");
	});

	it("找不到时原样返回", () => {
		const lines: Line[] = [toolLine];
		const next = updateTool(lines, "别的", (line) => ({ ...line, summary: "x" }));
		assert.equal(next, lines);
	});
});

describe("工具行成组", () => {
	const tool = (callId: string): Line => ({
		kind: "tool",
		callId,
		name: "read",
		args: undefined,
		running: false,
		isError: false,
		durationMs: 120,
		summary: "ok",
		detail: "",
		content: undefined,
		details: undefined,
	});

	it("连续调用并成一块,中间夹着别的行则断开", () => {
		const blocks = groupToolRuns([tool("a"), tool("b"), assistant("说一句"), tool("c")]);
		assert.deepEqual(
			blocks.map((block) => (block.kind === "tools" ? block.items.map((item) => item.callId) : block.line.kind)),
			[["a", "b"], "assistant", ["c"]],
		);
	});

	it("没有工具行时逐行返回", () => {
		const blocks = groupToolRuns([{ kind: "user", text: "你好" }, assistant("在")]);
		assert.deepEqual(
			blocks.map((block) => block.kind),
			["line", "line"],
		);
	});
});

describe("会话条目重放", () => {
	it("消息、思考与工具结果各归其位", () => {
		const lines = linesFromEntries([
			{
				type: "message",
				message: { role: "user", content: "修一下" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", text: "想想" },
						{ type: "toolCall", id: "t1", name: "read", arguments: {} },
						{ type: "text", text: "改好了" },
					],
				},
			},
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: "文件内容\n第二行", isError: false },
			},
		] as Parameters<typeof linesFromEntries>[0]);

		assert.deepEqual(lines, [
			{ kind: "user", text: "修一下" },
			{ kind: "thinking", text: "想想", open: false },
			{
				kind: "tool",
				callId: "t1",
				name: "read",
				args: {},
				running: false,
				isError: false,
				durationMs: undefined,
				summary: "文件内容",
				detail: "",
				content: "文件内容\n第二行",
				details: undefined,
			},
			{ kind: "assistant", text: "改好了", open: false },
		]);
	});

	it("非消息条目跳过,图片块显示为标记", () => {
		const lines = linesFromEntries([
			{ type: "model_change" },
			{ type: "message", message: { role: "user", content: [{ type: "image", name: "a.png" }] } },
		] as Parameters<typeof linesFromEntries>[0]);
		assert.deepEqual(lines, [{ kind: "user", text: "[image: a.png]" }]);
	});
});
