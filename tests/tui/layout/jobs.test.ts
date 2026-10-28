import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, FOOTER_INFO, exitTui, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import type { JobSource } from "../../../src/tui/options.ts";
import type { JobEvent } from "../../../src/tui/job.ts";
import type { JobView } from "../../../src/tui/job.ts";

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
		return {
			source: {
				list: () => jobs,
				kill: (id: string) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === undefined || job.status !== "running") return;
					const endedAt = Date.now();
					jobs = jobs.map((candidate) =>
						candidate.id === id ? { ...candidate, status: "killed", endedAt } : candidate,
					);
					emit({ type: "finished", job: jobs.find((job) => job.id === id)! });
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				shutdown: () => undefined,
			},
			jobs: () => jobs,
			finish(id, status) {
				const endedAt = Date.now();
				jobs = jobs.map((candidate) =>
					candidate.id === id ? { ...candidate, status, endedAt } : candidate,
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
