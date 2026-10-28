import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JsonStream, serializeEvent } from "../../src/cli/json-stream.ts";
import { runPrintMode } from "../../src/cli/print-mode.ts";

function linesOf(text: string): readonly Record<string, unknown>[] {
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("事件流", () => {
	it("一种事件写成一行，行尾带换行", () => {
		assert.equal(
			serializeEvent({ type: "text_delta", text: "a\nb" }),
			'{"type":"text_delta","text":"a\\nb"}\n',
		);
	});

	it("tool_end 不携带结果全文与结构化结果", () => {
		const line = serializeEvent({
			type: "tool_end",
			callId: "1",
			name: "read",
			isError: false,
			durationMs: 3,
			summary: "first line",
			content: "x".repeat(5000),
			details: { lines: 10 },
		});
		const parsed = JSON.parse(line) as Record<string, unknown>;
		// 全文与 details 都不在，摘要与耗时在：下游拿摘要就够判断这一行说什么
		assert.deepEqual(Object.keys(parsed).sort(), [
			"callId",
			"durationMs",
			"isError",
			"name",
			"summary",
			"type",
		]);
		assert.ok(!line.includes("details"));
	});

	it("结论：正常收尾为未失败", () => {
		const stream = new JsonStream({ write: () => {} });
		stream.handle({ type: "turn_end", stopReason: "stop" });
		assert.deepEqual(stream.result(), { failed: false, finished: true, error: undefined });
	});

	it("结论：出错与中止都算失败，并记下原因", () => {
		const failed = new JsonStream({ write: () => {} });
		failed.handle({ type: "error", message: "boom" });
		assert.deepEqual(failed.result(), { failed: true, finished: false, error: "boom" });

		const aborted = new JsonStream({ write: () => {} });
		aborted.handle({ type: "aborted" });
		assert.deepEqual(aborted.result(), { failed: true, finished: false, error: "interrupted" });
	});

	it("--json 只往标准输出写事件，退出码与文本模式一致", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];

		const code = await runPrintMode({
			prompt: "hi",
			json: true,
			createDriver: (onEvent) => ({
				async run(): Promise<void> {
					await onEvent({ type: "turn_start" });
					await onEvent({ type: "text_delta", text: "hello" });
					await onEvent({
						type: "tool_start",
						callId: "1",
						name: "read",
						args: { path: "README.md" },
					});
					await onEvent({
						type: "tool_end",
						callId: "1",
						name: "read",
						isError: false,
						durationMs: 4,
						summary: "contents",
					});
					await onEvent({ type: "turn_end", stopReason: "stop" });
				},
			}),
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		});

		assert.equal(code, 0);
		assert.deepEqual(
			linesOf(stdout.join("")).map((line) => line["type"]),
			["turn_start", "text_delta", "tool_start", "tool_end", "turn_end"],
		);
		// 标准输出里没有任何人类可读的进度；标准错误也没有被事件污染
		assert.equal(stderr.join(""), "");
	});

	it("--json 时驱动抛错也写成一条 error 事件，并返回非零", async () => {
		const stdout: string[] = [];

		const code = await runPrintMode({
			prompt: "hi",
			json: true,
			createDriver: () => ({
				async run(): Promise<void> {
					throw new Error("端点连不上");
				},
			}),
			stdout: (text) => stdout.push(text),
			stderr: () => {},
		});

		assert.equal(code, 1);
		const lines = linesOf(stdout.join(""));
		assert.equal(lines.length, 1);
		assert.equal(lines[0]?.["type"], "error");
		assert.match(String(lines[0]?.["message"]), /端点连不上/);
	});
});
