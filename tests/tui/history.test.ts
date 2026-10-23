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
			{ kind: "markdown", text: "hi" },
			{ kind: "tool", name: "Read", detail: "a.ts", group: "read", callId: "1", result: "file contents\nmore", metric: "2 lines", fullDetail: "1  file contents\n2  more", detailKind: "file" },
		]);
		assert.equal(turns[1]?.prompt, "next");
		assert.deepEqual(turns[1]?.response, [{ kind: "markdown", text: "done" }]);
	});

	it("工具成功不落行，失败保留一行", () => {
		const messages: LlmMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }],
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: "file contents",
				isError: false,
			},
			{
				role: "toolResult",
				toolCallId: "2",
				toolName: "bash",
				content: "boom",
				isError: true,
			},
		];

		const turns = buildTranscriptHistory(messages);

		assert.deepEqual(turns[0]?.response, [
			{ kind: "tool", name: "Read", detail: "a.ts", group: "read", callId: "1", result: "file contents", metric: "1 line", fullDetail: "1  file contents", detailKind: "file" },
			{ kind: "tool", name: "Bash", detail: "boom", isError: true },
		]);
	});

	it("失败结果改回调用行，不再另起一行", () => {
		const messages: LlmMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "false" } }],
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "bash",
				content: "exit 1\ndetail",
				isError: true,
			},
		];

		const turns = buildTranscriptHistory(messages);
		const response = turns[0]?.response ?? [];

		assert.equal(response.length, 1);
		const tool = response[0];
		assert.ok(typeof tool === "object" && tool !== null && tool.kind === "tool");
		if (typeof tool !== "object" || tool === null || tool.kind !== "tool") return;
		assert.equal(tool.isError, true);
		assert.equal(tool.detail, "false");
		assert.equal(tool.detailKind, "text");
		assert.ok((tool.fullDetail ?? "").includes("false"));
		assert.ok((tool.fullDetail ?? "").includes("exit 1\ndetail"));
	});

	it("连续只读调用回填成收起的工具组", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "2", name: "read", arguments: { path: "b.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: "a",
				isError: false,
			},
			{
				role: "toolResult",
				toolCallId: "2",
				toolName: "read",
				content: "b",
				isError: false,
			},
		];

		const turns = buildTranscriptHistory(messages);
		const group = turns[0]?.response[0];

		if (typeof group !== "object" || group === null || group.kind !== "toolGroup") {
			throw new Error("expected a tool group");
		}
		assert.equal(group.members.length, 2);
		assert.equal(group.expanded, false);
	});

	it("命令和写操作会断开工具组", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "2", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "3", name: "read", arguments: { path: "b.ts" } },
				],
			},
		];

		const turns = buildTranscriptHistory(messages);

		assert.deepEqual(
			turns[0]?.response.map((line) => (line as { kind?: string }).kind),
			["tool", "tool", "tool"],
		);
	});

	it("回填时连续够数的命令塌成收起的命令组", () => {
		const calls = Array.from({ length: 5 }, (_, i) => ({
			type: "toolCall" as const,
			id: `cmd${i}`,
			name: "bash",
			arguments: { command: `cmd${i}` },
		}));
		const messages: LlmMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: calls },
		];

		const turns = buildTranscriptHistory(messages);
		const group = turns[0]?.response[0];

		if (typeof group !== "object" || group === null || group.kind !== "toolGroup") {
			throw new Error("expected a tool group");
		}
		assert.equal(group.members.length, 5);
		assert.equal(group.expanded, false);
	});

	it("回填时失败的命令不进组", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: Array.from({ length: 5 }, (_, i) => ({
					type: "toolCall" as const,
					id: `cmd${i}`,
					name: "bash",
					arguments: { command: `cmd${i}` },
				})),
			},
			{ role: "toolResult", toolCallId: "cmd2", toolName: "bash", content: "boom", isError: true },
		];

		const turns = buildTranscriptHistory(messages);

		// 失败行把命令串切成两段：两段都不足门槛，全部保持逐行
		assert.equal(turns[0]?.response.length, 5);
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
		assert.deepEqual(turns[0]?.response, [{ kind: "markdown", text: "continued" }]);
	});
});
