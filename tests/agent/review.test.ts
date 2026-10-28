import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	buildReviewTask,
	collectReviewContext,
	parseReviewTarget,
} from "../../src/agent/review.ts";

function workdir(name: string): string {
	const directory = join(tmpdir(), `reins-review-${name}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}).trim();
}

function repository(): string {
	const dir = workdir("repo");
	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Reins Test"]);
	writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
	git(dir, ["add", "a.txt"]);
	git(dir, ["commit", "-m", "init"]);
	return dir;
}

describe("审查范围参数", () => {
	it("默认工作区，支持暂存区、基线与提交", () => {
		assert.deepEqual(parseReviewTarget(""), { kind: "working" });
		assert.deepEqual(parseReviewTarget("--staged"), { kind: "staged" });
		assert.deepEqual(parseReviewTarget("--base main"), { kind: "base", ref: "main" });
		assert.deepEqual(parseReviewTarget("--commit HEAD~1"), { kind: "commit", ref: "HEAD~1" });
		assert.deepEqual(parseReviewTarget("HEAD~2"), { kind: "base", ref: "HEAD~2" });
	});

	it("缺参数、未知选项与多余参数都明确报错", () => {
		assert.throws(() => parseReviewTarget("--base"), /requires a git ref/);
		assert.throws(() => parseReviewTarget("--commit"), /requires a git ref/);
		assert.throws(() => parseReviewTarget("--staged extra"), /does not take extra/);
		assert.throws(() => parseReviewTarget("--wat"), /Unknown review option/);
		assert.throws(() => parseReviewTarget("a b"), /one git ref/);
	});
});

describe("审查上下文", () => {
	it("工作区改动、暂存区、基线与提交各自取到对应的 diff", () => {
		const dir = repository();
		try {
			writeFileSync(join(dir, "a.txt"), "two\n", "utf8");

			const working = collectReviewContext(dir, { kind: "working" });
			assert.equal(working.label, "Working tree");
			assert.equal(working.hasChanges, true);
			assert.match(working.diff, /-one/);
			assert.match(working.diff, /\+two/);
			assert.match(working.status, /a\.txt/);

			git(dir, ["add", "a.txt"]);
			const staged = collectReviewContext(dir, { kind: "staged" });
			assert.equal(staged.label, "Staged changes");
			assert.match(staged.diff, /\+two/);

			const sha = git(dir, ["rev-parse", "HEAD"]);
			const commit = collectReviewContext(dir, { kind: "commit", ref: sha });
			assert.match(commit.label, /^Commit /);
			assert.match(commit.diff, /\+one/);

			const base = collectReviewContext(dir, { kind: "base", ref: "HEAD" });
			assert.equal(base.label, "Changes since HEAD");
			assert.equal(base.diff, "");
			// 文件仍有改动，所以不能因为没有 diff 就当成没事可审
			assert.equal(base.hasChanges, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("任务说明包含范围、状态、diff 与只读约束", () => {
		const dir = repository();
		try {
			writeFileSync(join(dir, "a.txt"), "two\n", "utf8");
			const task = buildReviewTask(collectReviewContext(dir, { kind: "working" }));

			assert.match(task, /read-only review/);
			assert.match(task, /Working tree/);
			assert.match(task, /M a\.txt/);
			assert.match(task, /```diff/);
			assert.match(task, /Do not restate the diff/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
