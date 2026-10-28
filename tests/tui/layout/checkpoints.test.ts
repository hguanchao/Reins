import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, FOOTER_INFO, exitTui, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";

describe("检查点与撤销", () => {
	function makeSource(
		available = true,
		overrides: {
			latestUndoable?: () => Promise<undefined>;
			restoreError?: string;
		} = {},
	): {
		source: import("../../../src/tui/options.ts").CheckpointSource;
		readonly restored: string[];
	} {
		const preview = {
			entry: {
				id: "t2",
				turn: 2,
				createdAt: Date.now() - 60_000,
				kind: "turn" as const,
				label: "Turn 2",
				changes: 1,
			},
			changes: [{ path: "src/a.ts", status: "modified" as const }],
		};
		const restored: string[] = [];
		return {
			restored,
			source: {
				available: () => available,
				error: () => (available ? undefined : "Checkpoints need a Git repository"),
				latestUndoable: async () => {
					if (overrides.latestUndoable !== undefined) return overrides.latestUndoable();
					return available ? preview : undefined;
				},
				restore: async () => {
					if (overrides.restoreError !== undefined) throw new Error(overrides.restoreError);
					restored.push(preview.entry.id);
					return {
						entry: preview.entry,
						restored: 1,
						removed: 0,
						safety: { ...preview.entry, id: "s1", kind: "safety", label: "Before undo of Turn 2" },
					};
				},
			},
		};
	}

	it("/undo 直接恢复最近变更并在对话流留下记录", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const { source: checkpointSource, restored } = makeSource();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
checkpoints: checkpointSource,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.deepEqual(restored, ["t2"]);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Undid Turn 2 · 1 restored"));
			assert.equal(text.includes("Reins — checkpoints"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有可恢复的变更时给出提示", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		const { source: checkpointSource } = makeSource(true, { latestUndoable: () => Promise.resolve(undefined) });
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
checkpoints: checkpointSource,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.ok(frameLines(output).map(plain).join("\n").includes("No file changes to undo"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("恢复失败时在对话流里给出原因", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		const { source: checkpointSource } = makeSource(true, { restoreError: "git failed" });
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
checkpoints: checkpointSource,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Error: git failed"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("检查点不可用时命令给出原因", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		const { source: checkpointSource } = makeSource(false);
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
checkpoints: checkpointSource,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/undo\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.ok(
				frameLines(output).map(plain).join("\n").includes("Checkpoints need a Git repository"),
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
