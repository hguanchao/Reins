import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, FOOTER_INFO, exitTui, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import type { JobSource } from "../../../src/tui/options.ts";
import type { JobEvent } from "../../../src/tui/page/job.ts";
import type { JobView } from "../../../src/tui/page/job.ts";

describe("后台作业", () => {
	function fakeJobs(initial: readonly JobView[] = []): {
		readonly source: JobSource;
		readonly jobs: () => readonly JobView[];
		finish(id: string, status: "done" | "failed" | "killed"): void;
	} {
		let jobs = [...initial];
		const listeners = new Set<(event: JobEvent) => void>();
		const emit = (event: JobEvent): void => {
			for (const listener of listeners) listener(event);
		};
		const output = new Map<string, string>([["j1", "line one\nline two\n"]]);
		return {
			source: {
				list: () => jobs,
				output: (id) => output.get(id) ?? "",
				kill: (id) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === undefined || job.status !== "running") return;
					const endedAt = Date.now();
					jobs = jobs.map((candidate) =>
						candidate.id === id ? { ...candidate, status: "killed", endedAt } : candidate,
					);
					emit({ type: "finished", job: jobs.find((candidate) => candidate.id === id)! });
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				shutdown: () => undefined,
			},
			jobs: () => jobs,
			finish: (id, status) => {
				const endedAt = Date.now();
				jobs = jobs.map((job) =>
					job.id === id ? { ...job, status, endedAt, exitCode: status === "done" ? 0 : 1 } : job,
				);
				emit({ type: "finished", job: jobs.find((job) => job.id === id)! });
			},
		};
	}

	const running: JobView = {
		id: "j1",
		command: "npm run dev",
		status: "running",
		startedAt: Date.now() - 42_000,
		sessionId: "s",
	};

	it("运行中作业在页脚上方显示 Jobs bar", async () => {
		const fake = fakeJobs([running]);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const runningTui = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			jobs: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("◎ Jobs"));
			assert.ok(text.includes("1 running"));
			assert.ok(text.includes("npm run dev"));
			assert.ok(text.includes("/jobs"));
		} finally {
			exitTui(input);
		}

		assert.equal(await runningTui, 0);
	});

	it("/jobs 打开列表，Enter 看输出，k 终止", async () => {
		const fake = fakeJobs([running]);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const runningTui = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			jobs: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/jobs\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — jobs"));
			assert.ok(text.includes("▸ j1"));
			assert.ok(text.includes("npm run dev"));
			assert.ok(text.includes("Enter view output"));

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — jobs · j1"));
			assert.ok(text.includes("line one"));
			assert.ok(text.includes("k kill"));

			input.emit("data", Buffer.from("k"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("killed"));

			// 从输出页回到列表，再关掉页面才能看到对话流里的完成说明
			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins — jobs"));
			assert.equal(text.includes("Reins — jobs · j1"), false);

			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Job j1 killed"));
			assert.equal(text.includes("Reins — jobs"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await runningTui, 0);
	});

	it("作业完成追加说明，Jobs bar 随运行数消失", async () => {
		const fake = fakeJobs([running]);
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const runningTui = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			jobs: fake.source,
			stdin: input,
			stdout: output,
		});

		try {
			fake.finish("j1", "done");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Job j1 finished"));
			assert.ok(text.includes("npm run dev"));
			assert.equal(text.includes("◎ Jobs"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await runningTui, 0);
	});
});
