import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTimestamp, renderSessionMarkdown } from "../../src/session/export.ts";
import type { SessionEntry, SessionHeaderEntry } from "../../src/session/port.ts";

const T = "2026-01-01T00:00:00Z";

function header(id: string): SessionHeaderEntry {
	return { type: "session", version: 1, id, timestamp: T, cwd: "E:\\w" };
}

function userMessage(id: string, text: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: T, message: { role: "user", content: text } };
}

function assistantMessage(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: T,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "the answer" },
				{ type: "thinking", text: "private thought" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
			],
		},
	};
}

describe("时间格式", () => {
	it("ISO 转本地时间", () => {
		const formatted = formatTimestamp("2026-03-05T06:07:08Z");
		assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("非法时间原样返回", () => {
		assert.equal(formatTimestamp("not-a-time"), "not-a-time");
	});
});

describe("会话导出", () => {
	it("头部含开始时间、目录与条目数", () => {
		const markdown = renderSessionMarkdown(header("s1"), [userMessage("a", "hi")]);
		assert.match(markdown, /^# Session s1\n/);
		assert.match(markdown, /- Started: /);
		assert.match(markdown, /- Directory: E:\\w/);
		assert.match(markdown, /- Entries: 1/);
	});

	it("对话按角色分节,assistant 带思考与工具调用", () => {
		const markdown = renderSessionMarkdown(header("s"), [userMessage("a", "why?"), assistantMessage("b")]);
		assert.ok(markdown.includes("## Conversation"));
		assert.ok(markdown.includes("### User\n\nwhy?"));
		assert.ok(markdown.includes("### Assistant"));
		assert.ok(markdown.includes("the answer"));
		assert.ok(markdown.includes("> **Thinking**\n> private thought"));
		assert.ok(markdown.includes("Tool call `read`:"));
	});

	it("工具结果带失败标记,内容排进引用块", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "r",
			parentId: null,
			timestamp: T,
			message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "line1\nline2", isError: true },
		};
		const markdown = renderSessionMarkdown(header("s"), [entry]);
		assert.ok(markdown.includes("### Tool result bash (failed)"));
		assert.ok(markdown.includes("> line1\n> line2"));
	});

	it("system/model_change/effort_change 各有一行说明", () => {
		const entries: SessionEntry[] = [
			{ type: "system", id: "s", parentId: null, timestamp: T, sections: { toolset: null, list: "on" }, toolsAdded: [{ name: "grep", description: "", parameters: {} }], toolsRemoved: ["old"] },
			{ type: "model_change", id: "m", parentId: null, timestamp: T, provider: "p", model: "m1" },
			{ type: "effort_change", id: "e", parentId: null, timestamp: T, effort: "high" },
		];
		const markdown = renderSessionMarkdown(header("s"), entries);
		assert.ok(markdown.includes("> Prompt: Removed toolset, Updated list, +grep, -old"));
		assert.ok(markdown.includes("> Model switched to p/m1"));
		assert.ok(markdown.includes("> Reasoning effort switched to high"));
	});

	it("空会话给出占位说明", () => {
		const markdown = renderSessionMarkdown(header("s"), []);
		assert.ok(markdown.includes("(no conversation yet)"));
		assert.ok(markdown.includes("## Usage"));
	});

	it("压缩点在对话里留一行,末尾有专节", () => {
		const compaction: SessionEntry = {
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: T,
			summary: "we talked about files",
			covered: ["a", "b"],
			provider: "p",
			model: "m",
			tokensBefore: 9000,
			usage: undefined,
		};
		const markdown = renderSessionMarkdown(header("s"), [userMessage("a", "x"), compaction]);
		assert.ok(markdown.includes("> Context compacted: 2 messages covered"));
		assert.ok(markdown.includes("## Context compaction"));
		assert.ok(markdown.includes("Covered 2 messages, about 9000 tokens"));
		assert.ok(markdown.includes("we talked about files"));
	});

	it("用量条目不逐条出现，只在尾部汇总", () => {
		const usage: SessionEntry = {
			type: "usage",
			id: "u",
			parentId: null,
			timestamp: T,
			provider: "p",
			model: "m",
			kind: "turn",
			usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 },
			cost: undefined,
		};
		const markdown = renderSessionMarkdown(header("s"), [usage]);
		assert.match(markdown, /- requests: 1 +input: 5 +output: 5 .+total: 10 tokens/);
	});

	it("没有头时标注缺头", () => {
		const markdown = renderSessionMarkdown(undefined, []);
		assert.ok(markdown.includes("# Session (missing session header)"));
	});
});
