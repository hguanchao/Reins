import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runTui } from "#src/tui/layout.ts";
import type { ExportSource } from "#src/tui/options.ts";
import {
	FakeInput,
	FakeOutput,
	FOOTER_INFO,
	createFakeAgent,
	exitTui,
	frameLines,
	plain,
} from "#tests/tui/support/harness.ts";

function screen(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

function source(targets: (string | undefined)[]): ExportSource {
	return {
		export: async (target) => {
			targets.push(target);
			return `Exported markdown to ${target ?? "default.md"} (1 KB, created)`;
		},
	};
}

describe("会话导出命令", () => {
	it("/export 默认路径与显式路径都交给宿主，结果落进对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const targets: (string | undefined)[] = [];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			exportSession: source(targets),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/export\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(targets, [undefined]);
			assert.ok(screen(output).includes("Exported markdown to default.md"));

			input.emit("data", Buffer.from("/export out.md\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(targets, [undefined, "out.md"]);
			assert.ok(screen(output).includes("Exported markdown to out.md"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("导出失败时显示错误行", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			exportSession: { export: async () => Promise.reject(new Error("disk full")) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/export\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(screen(output).includes("Error: export failed · disk full"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有导出源时给出提示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/export\r"));
			assert.ok(screen(output).includes("Session export isn't available"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("一轮进行中拒绝导出", async (t) => {
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
			exportSession: source([]),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(50);
			input.emit("data", Buffer.from("/export\r"));
			assert.ok(screen(output).includes("/export: wait for the running turn to finish"), screen(output));
			await agent.finish();
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
