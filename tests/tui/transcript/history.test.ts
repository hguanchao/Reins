import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmMessage } from "../../../src/llm/messages.ts";
import { buildTranscriptHistory } from "../../../src/tui/transcript/history.ts";

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

		const turns = buildTranscriptHistory(messages).turns;

		assert.equal(turns.length, 2);
		assert.equal(turns[0]?.prompt, "hello");
		assert.deepEqual(turns[0]?.response, [
			{ kind: "markdown", text: "hi" },
			{ kind: "tool", name: "Read", detail: "a.ts", group: "read", callId: "1", result: "file contents\nmore", metric: "2 lines", fullDetail: "1  file contents\n2  more", detailKind: "file" },
		]);
		assert.equal(turns[1]?.prompt, "next");
		assert.deepEqual(turns[1]?.response, [{ kind: "markdown", text: "done" }]);
	});

	it("present_plan 回填为计划卡，并带出最近一份计划", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "plan it" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Here is the plan." },
					{ type: "toolCall", id: "p1", name: "present_plan", arguments: { plan: "# Add Plan mode\n\n1. Do it." } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "p1",
				toolName: "present_plan",
				content: "Plan submitted for review.",
				isError: false,
			},
		];

		const history = buildTranscriptHistory(messages);
		const plan = { kind: "plan" as const, text: "# Add Plan mode\n\n1. Do it." };

		assert.deepEqual(history.turns[0]?.response, [
			{ kind: "markdown", text: "Here is the plan." },
			plan,
		]);
		assert.deepEqual(history.plan, plan);
	});

	it("空 present_plan 不产生计划卡", () => {
		const history = buildTranscriptHistory([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "p1", name: "present_plan", arguments: { plan: "  " } },
				],
			},
		]);

		assert.equal(history.plan, undefined);
		assert.equal(
			history.turns[0]?.response.some(
				(line) => typeof line === "object" && line !== null && line.kind === "plan",
			),
			false,
		);
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

		const turns = buildTranscriptHistory(messages).turns;

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

		const turns = buildTranscriptHistory(messages).turns;
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

		const turns = buildTranscriptHistory(messages).turns;
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

		const turns = buildTranscriptHistory(messages).turns;

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

		const turns = buildTranscriptHistory(messages).turns;
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

		const turns = buildTranscriptHistory(messages).turns;

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

		const turns = buildTranscriptHistory(messages).turns;

		assert.equal(turns.length, 1);
		assert.equal(turns[0]?.prompt, "(earlier conversation)");
		assert.deepEqual(turns[0]?.response, [{ kind: "markdown", text: "continued" }]);
	});
});

describe("会话历史回填任务表", () => {
	it("未收尾的 todo 调用只带出任务表,不进对话流", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "1",
						name: "todo",
						arguments: {
							explanation: "开工",
							todos: [{ content: "写工具", status: "in_progress" }],
						},
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "todo",
				content: "Task list updated: 0 of 1 done.",
				isError: false,
			},
		];

		const history = buildTranscriptHistory(messages);

		// 只有用户提示这一轮;任务表单独带出,供常驻面板恢复
		assert.equal(history.turns.length, 1);
		assert.deepEqual(history.turns[0]?.response, []);
		assert.deepEqual(history.todo, {
			kind: "todo",
			explanation: "开工",
			items: [{ content: "写工具", status: "in_progress" }],
			collapsed: false,
		});
	});

	it("收尾的旧表进对话流,最后一张未收尾的表留给面板", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "1",
						name: "todo",
						arguments: { todos: [{ content: "第一步", status: "completed" }] },
					},
					{
						type: "toolCall",
						id: "2",
						name: "todo",
						arguments: {
							todos: Array.from({ length: 6 }, (_, index) => ({
								content: `任务${index + 1}`,
								status: "pending",
							})),
						},
					},
				],
			},
		];

		const history = buildTranscriptHistory(messages);

		assert.equal(history.todo?.collapsed, true);
		assert.equal(history.todo?.items.length, 6);
		assert.deepEqual(
			history.turns[0]?.response.map((line) => (line as { kind?: string }).kind),
			["todo"],
		);
	});

	it("全部收尾的任务表回填进对话流,面板不再保留", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "1",
						name: "todo",
						arguments: {
							todos: [
								{ content: "写工具", status: "completed" },
								{ content: "补测试", status: "failed" },
							],
						},
					},
				],
			},
		];

		const history = buildTranscriptHistory(messages);

		assert.equal(history.todo, undefined);
		assert.equal(history.turns[0]?.response.length, 1);
		const card = history.turns[0]?.response[0];
		assert.equal(typeof card === "object" && card !== null && card.kind === "todo", true);
		if (typeof card === "object" && card !== null && card.kind === "todo") {
			assert.equal(card.items.length, 2);
		}
	});

	it("先进行后收尾:中间态不再进对话流,只保留收尾的那张", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "1",
						name: "todo",
						arguments: { todos: [{ content: "写工具", status: "in_progress" }] },
					},
					{
						type: "toolCall",
						id: "2",
						name: "todo",
						arguments: { todos: [{ content: "写工具", status: "completed" }] },
					},
				],
			},
		];

		const history = buildTranscriptHistory(messages);

		assert.equal(history.todo, undefined);
		assert.equal(history.turns[0]?.response.length, 1);
		const card = history.turns[0]?.response[0];
		assert.equal(typeof card === "object" && card !== null && card.kind === "todo", true);
		if (typeof card === "object" && card !== null && card.kind === "todo") {
			assert.equal(card.items[0]?.status, "completed");
		}
	});

	it("空表表示清空,面板与对话流都不留记录", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "todo", arguments: { todos: [] } },
				],
			},
		];

		const history = buildTranscriptHistory(messages);

		assert.equal(history.todo, undefined);
		assert.deepEqual(history.turns[0]?.response, []);
	});

	it("畸形参数退回普通工具行,失败结果挂在该行上", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "2", name: "todo", arguments: { todos: "nope" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "2",
				toolName: "todo",
				content: "Arguments must be an object, got string",
				isError: true,
			},
		];

		const history = buildTranscriptHistory(messages);

		assert.equal(history.todo, undefined);
		assert.equal(history.turns[0]?.response.length, 1);
		const line = history.turns[0]?.response[0];
		assert.equal(typeof line === "object" && line !== null && line.kind === "tool", true);
		if (typeof line === "object" && line !== null && line.kind === "tool") {
			assert.equal(line.isError, true);
			assert.equal(line.name, "Todo");
		}
	});
});

describe("会话历史回填子代理组", () => {
	it("同一条助手消息里的多个子代理调用回填为一个组,结果改成员状态", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "s1", name: "subagent", arguments: { task: "梳理结构" } },
					{ type: "toolCall", id: "s2", name: "subagent", arguments: { task: "修路径" } },
				],
			},
			{ role: "toolResult", toolCallId: "s1", toolName: "subagent", content: "结构如下……", isError: false },
			{ role: "toolResult", toolCallId: "s2", toolName: "subagent", content: "The subagent failed: boom", isError: true },
		];

		const turns = buildTranscriptHistory(messages).turns;
		const group = turns[0]?.response[0];
		if (typeof group !== "object" || group === null || group.kind !== "subagentGroup") {
			throw new Error("expected a subagent group");
		}
		assert.equal(group.members.length, 2);
		assert.equal(group.members[0]?.status, "done");
		assert.equal(group.members[1]?.status, "failed");
		assert.equal(group.members[1]?.failure, "The subagent failed: boom");
	});

	it("普通工具与子代理混排时互不影响", () => {
		const messages: LlmMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "r", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "s", name: "subagent", arguments: { task: "梳理" } },
				],
			},
			{ role: "toolResult", toolCallId: "r", toolName: "read", content: "x", isError: false },
			{ role: "toolResult", toolCallId: "s", toolName: "subagent", content: "ok", isError: false },
		];

		const turns = buildTranscriptHistory(messages).turns;
		const kinds = turns[0]?.response.map((line) => (line as { kind?: string }).kind);
		assert.deepEqual(kinds, ["tool", "subagentGroup"]);
	});

	it("图片标记在用户消息块里显示，纯图片消息仍算一个回合", () => {
		const messages: LlmMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "看一下这个间距 [image: screenshot.png]" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "screenshot.png" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "我先看截图。" }] },
			{
				role: "user",
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
		];

		const turns = buildTranscriptHistory(messages).turns;
		// 正文已有标记时不重复补；旧会话没有标记时补在提示块末尾，而不是另起回复行
		assert.equal(turns[0]?.prompt, "看一下这个间距 [image: screenshot.png]");
		assert.deepEqual(turns[0]?.response, [{ kind: "markdown", text: "我先看截图。" }]);
		assert.equal(turns[1]?.prompt, "[image: image]");
		assert.deepEqual(turns[1]?.response, []);
	});
});
