import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	JOB_ACTION_HEIGHT,
	jobListActions,
	jobListLines,
	jobOutputActions,
	jobOutputLines,
	type JobView,
} from "../../src/tui/job-pages.ts";
import { displayWidth } from "../../src/tui/text.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const NOW = Date.now();
const RUNNING: JobView = {
	id: "j1",
	command: "npm run dev",
	status: "running",
	startedAt: NOW - 42_000,
	sessionId: "s",
};
const DONE: JobView = {
	id: "j2",
	command: "npm test",
	status: "done",
	startedAt: NOW - 63_000,
	endedAt: NOW,
	exitCode: 0,
	sessionId: "s",
};
const FAILED: JobView = {
	id: "j3",
	command: "npm run build",
	status: "failed",
	startedAt: NOW - 18_000,
	endedAt: NOW,
	exitCode: 1,
	sessionId: "s",
};

describe("后台作业页面", () => {
	it("列表显示运行、完成与失败，光标停在选中行", () => {
		const lines = jobListLines([RUNNING, DONE, FAILED], 80, 0);
		const text = plain(lines.join("\n"));

		assert.ok(text.includes("Reins — jobs"));
		assert.ok(text.includes("▸ j1"));
		assert.ok(text.includes("npm run dev"));
		assert.ok(text.includes("running"));
		assert.ok(text.includes("j2"));
		assert.ok(text.includes("exit 0"));
		assert.ok(text.includes("failed"));
		assert.ok(text.includes("Jobs are killed when Reins exits."));
		for (const line of lines) assert.ok(displayWidth(plain(line)) <= 80);
	});

	it("输出页展示命令、状态与日志", () => {
		const lines = jobOutputLines(RUNNING, "line one\nline two\n", 80);
		const text = plain(lines.join("\n"));

		assert.ok(text.includes("Reins — jobs · j1"));
		assert.ok(text.includes("npm run dev"));
		assert.ok(text.includes("running"));
		assert.ok(text.includes("line one"));
		assert.ok(text.includes("line two"));
		for (const line of lines) assert.ok(displayWidth(plain(line)) <= 80);
	});

	it("空输出有占位，动作按运行状态变化", () => {
		const empty = jobOutputLines(RUNNING, "", 60);
		assert.ok(plain(empty.join("\n")).includes("[no output yet]"));

		const runningActions = jobOutputActions(80, "running");
		assert.ok(plain(runningActions[1] ?? "").includes("k kill"));
		assert.ok(plain(runningActions[1] ?? "").includes("Esc back"));

		const doneActions = jobOutputActions(80, "done");
		assert.equal(plain(doneActions[1] ?? "").includes("kill"), false);
		assert.ok(plain(doneActions[1] ?? "").includes("Esc back"));

		const listActions = jobListActions(80);
		assert.ok(plain(listActions[1] ?? "").includes("Enter view output"));
		assert.ok(plain(listActions[1] ?? "").includes("k kill"));
		assert.equal(JOB_ACTION_HEIGHT, 2);
	});
});
