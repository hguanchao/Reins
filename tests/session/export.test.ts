import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { renderSessionMarkdown, writeSessionExport } from "#src/session/export.ts";
import { summaryMessage } from "#src/session/fold.ts";
import { JsonlSessionStore } from "#src/session/jsonl-store.ts";
import { Session } from "#src/session/session.ts";

function workdir(name: string): string {
	const directory = join(tmpdir(), `reins-export-${name}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

async function sampleSession(): Promise<Session> {
	const session = new Session({ id: "export-test", cwd: "/work", file: null });
	await session.append({ type: "message", message: { role: "user", content: "hello" } });
	await session.append({
		type: "message",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" },
			],
		},
	});
	await session.append({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "reading it" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
			],
		},
	});
	await session.append({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: "file content",
			isError: false,
		},
	});
	await session.append({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "c2", name: "present_plan", arguments: { plan: "# Plan\nDo it" } }],
		},
	});
	await session.append({ type: "message", message: summaryMessage("earlier work") });
	return session;
}

describe("会话导出", () => {
	it("Markdown 包含用户、助手、工具调用、工具结果与计划", async () => {
		const session = await sampleSession();
		const text = renderSessionMarkdown(session);

		assert.match(text, /^# Reins session export-test/m);
		assert.match(text, /## User\n\nhello/);
		assert.match(text, /## User\n\nlook at this/);
		assert.match(text, /\[image: shot\.png\]/);
		assert.match(text, /## Assistant\n\nreading it/);
		assert.match(text, /### Tool call: read/);
		assert.match(text, /"path": "a\.ts"/);
		assert.match(text, /### Tool result: read/);
		assert.match(text, /file content/);
		assert.match(text, /## Plan\n\n# Plan\nDo it/);
		// 摘要不冒充使用者刚说过的话
		assert.match(text, /## Summary\n\nearlier work/);
		await session.close();
	});

	it("Markdown 写入文件并报告创建/覆盖", async () => {
		const dir = workdir("markdown");
		const session = await sampleSession();
		const target = join(dir, "out.md");

		const first = writeSessionExport(session, target);
		assert.equal(first.format, "markdown");
		assert.equal(first.created, true);
		assert.ok(first.bytes > 0);
		assert.match(readFileSync(target, "utf8"), /hello/);

		const second = writeSessionExport(session, target);
		assert.equal(second.created, false);
		await session.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("JSONL 复制会话文件，内存会话明确拒绝", async () => {
		const dir = workdir("jsonl");
		const store = new JsonlSessionStore();
		const file = join(dir, "session.jsonl");
		const session = new Session({ id: "jsonl", cwd: dir, file, writer: store.create({ id: "jsonl", cwd: dir, file }) });
		await session.append({ type: "message", message: { role: "user", content: "one" } });

		const target = join(dir, "out.jsonl");
		const result = writeSessionExport(session, target);
		assert.equal(result.format, "jsonl");
		assert.equal(readFileSync(target, "utf8"), readFileSync(file, "utf8"));
		// 复制到自身会截断源文件，必须拒绝
		assert.throws(() => writeSessionExport(session, file), /session file itself/);
		await session.close();

		const memory = new Session({ id: "memory", cwd: dir, file: null });
		assert.throws(() => writeSessionExport(memory, join(dir, "memory.jsonl")), /not saved to a file/);
		await memory.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("空会话导出仍然有标题", () => {
		const session = new Session({ id: "empty", cwd: "/work", file: null });
		const text = renderSessionMarkdown(session);
		assert.match(text, /# Reins session empty/);
		assert.match(text, /_No messages yet\._/);
	});
});
