import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runPrintMode } from "../../src/cli/print-mode.ts";

describe("非交互模式", () => {
	it("工具调用用可读摘要，答案与过程分开输出", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];

		const code = await runPrintMode({
			prompt: "hi",
			createDriver: (onEvent) => ({
				async run(): Promise<void> {
					await onEvent({ type: "text_delta", text: "hello" });
					await onEvent({
						type: "tool_start",
						callId: "1",
						name: "read",
						args: { path: "README.md", offset: 10 },
					});
					await onEvent({
						type: "tool_end",
						callId: "1",
						name: "read",
						isError: false,
						durationMs: 12,
						summary: "",
					});
					await onEvent({ type: "turn_end", stopReason: "stop" });				},
			}),
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		});

		assert.equal(code, 0);
		assert.equal(stdout.join(""), "hello\n");
		assert.ok(stderr.join("").includes("› Read  README.md  [offset 10]"));
		assert.equal(stderr.join("").includes('{"path"'), false);
		assert.equal(stderr.join("").includes("done"), false);
	});

	it("工具失败与中止统一用 × 标记", async () => {
		const stderr: string[] = [];

		const code = await runPrintMode({
			prompt: "hi",
			createDriver: (onEvent) => ({
				async run(): Promise<void> {
					await onEvent({
						type: "tool_start",
						callId: "1",
						name: "bash",
						args: { command: "false" },
					});
					await onEvent({
						type: "tool_end",
						callId: "1",
						name: "bash",
						isError: true,
						durationMs: 3,
						summary: "exit 1",
					});
					await onEvent({ type: "aborted" });
				},
			}),
			stdout: () => {},
			stderr: (text) => stderr.push(text),
		});

		assert.equal(code, 1);
		assert.ok(stderr.join("").includes("× Bash  exit 1 (3ms)"));
		assert.ok(stderr.join("").includes("× Error: aborted"));
	});
});
