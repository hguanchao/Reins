import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, FOOTER_INFO, exitTui, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";

describe("检查点与撤销", () => {
	function source(available = true): {
		source: import("../../../src/tui/options.ts").CheckpointSource;
		readonly restored: string[];
	} {
		const entry = {
			id: "t2",
			turn: 2,
			createdAt: Date.now() - 60_000,
			kind: "turn" as const,
			label: "Turn 2",
			changes: 1,
		};
		const preview = {
			entry,
			changes: [{ path: "src/a.ts", status: "modified" as const }],
		};
		const restored: string[] = [];
		return {
			restored,
			source: {
				available: () => available,
				error: () => (available ? undefined : "Checkpoints need a Git repository"),
				list: () => (available ? [entry] : []),
				latestUndoable: async () => (available ? preview : undefined),
				preview: async () => preview,
				restore: async () => {
					restored.push(entry.id);
					return { entry, restored: 1, removed: 0, safety: { ...entry, id: "s1", kind: "safety", label: "Before undo of Turn 2" } };
				},
			},
		};
	}

	it("/checkpoints 打开列表、预览并恢复", async () => {
		const fake = source();
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/checkpoints\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — checkpoints"));
			assert.ok(text.includes("Turn 2"));

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — undo"));
			assert.ok(text.includes("M  src/a.ts"));
			assert.ok(text.includes("will be restored"));

			input.emit("data", Buffer.from("u"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(fake.restored, ["t2"]);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› /undo"));
			assert.ok(text.includes("Undid Turn 2"));
			assert.equal(text.includes("Reins — undo"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/undo 直接预览最近变更并恢复", async () => {
		const fake = source();
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — undo"));

			input.emit("data", Buffer.from("u"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(fake.restored, ["t2"]);
			assert.ok(plain(frameLines(output).join("\n")).includes("Undid Turn 2"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("列表预览后 Esc 取消回列表", async () => {
		const fake = source();
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/checkpoints\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — undo"));

			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins — checkpoints"));

			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(plain(frameLines(output).join("\n")).includes("Reins — checkpoints"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("检查点不可用时命令给出原因，不打开页面", async () => {
		const fake = source(false);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			checkpoints: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const text = plain(frameLines(output).join("\n"));
			assert.ok(text.includes("Checkpoints need a Git repository"));
			assert.equal(text.includes("Reins — undo"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
