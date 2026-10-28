import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runTui } from "../../../src/tui/layout.ts";
import type { ReviewSource } from "../../../src/tui/options.ts";
import {
	FakeInput,
	FakeOutput,
	FOOTER_INFO,
	createFakeAgent,
	exitTui,
	frameLines,
	plain,
	pressCtrlC,
} from "../support/harness.ts";

function screen(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

function source(report: string): ReviewSource {
	return {
		run: async (_args, _signal, onProgress) => {
			onProgress("step 1/2");
			return { label: "Working tree", report, steps: 2, durationMs: 120, stopReason: "done" };
		},
	};
}

describe("审查命令", () => {
	it("/review 在对话流里显示范围与报告", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			review: source("No issues found."),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/review\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const text = screen(output);
			assert.ok(text.includes("Working tree · 2 steps"));
			assert.ok(text.includes("No issues found."));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有审查源时给出提示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/review\r"));
			assert.ok(screen(output).includes("Code review is unavailable"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("一轮进行中拒绝审查", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 16;
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			review: source("unused"),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("/review\r"));
			assert.ok(screen(output).includes("/review is unavailable while a turn is running"), screen(output));
			await agent.finish();
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Ctrl+C 中止审查并显示中止报告", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const waiting: ReviewSource = {
			run: (_args, signal) =>
				new Promise((resolve) => {
					signal.addEventListener(
						"abort",
						() =>
							resolve({
								label: "Working tree",
								report: "Review cancelled.",
								steps: 1,
								durationMs: 10,
								stopReason: "aborted",
							}),
						{ once: true },
					);
				}),
		};
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			review: waiting,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/review\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			pressCtrlC(input);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const text = screen(output);
			assert.ok(text.includes("Review cancelled."));
			assert.ok(text.includes("aborted"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
