import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { currentBranch, gitDiff, gitStatus } from "#src/workspace/git.ts";

const HAS_GIT = ((): boolean => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("git 分支", () => {
	it("不在仓库里时安静地返回 undefined", () => {
		const root = mkdtempSync(join(tmpdir(), "reins-git-"));
		dirs.push(root);
		assert.equal(currentBranch(root), undefined);
	});

	it(
		"仓库里返回当前分支名",
		{ skip: !HAS_GIT },
		() => {
			const root = mkdtempSync(join(tmpdir(), "reins-git-"));
			dirs.push(root);
			execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
			execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: root, stdio: "ignore" });
			assert.equal(currentBranch(root), "feature");
		},
	);
});

describe("git 状态与 diff", () => {
	function repository(): string {
		const root = mkdtempSync(join(tmpdir(), "reins-git-"));
		dirs.push(root);
		execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
		return root;
	}

	function git(root: string, args: readonly string[]): void {
		execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	}

	it(
		"区分未暂存修改、未跟踪与已暂存新增",
		{ skip: !HAS_GIT },
		() => {
			const root = repository();
			writeFileSync(join(root, "a.txt"), "old\n");
			git(root, ["add", "a.txt"]);
			git(root, ["commit", "-m", "init"]);

			writeFileSync(join(root, "a.txt"), "new\n");
			writeFileSync(join(root, "b.txt"), "untracked\n");
			writeFileSync(join(root, "c.txt"), "staged\n");
			git(root, ["add", "c.txt"]);

			const status = gitStatus(root);
			assert.ok(status);
			assert.equal(typeof status.branch, "string");
			assert.ok(status.files.some((file) => file.path === "a.txt" && file.kind === "modified" && !file.staged));
			assert.ok(status.files.some((file) => file.path === "b.txt" && file.kind === "untracked"));
			assert.ok(status.files.some((file) => file.path === "c.txt" && file.kind === "added" && file.staged));
		},
	);

	it(
		"未暂存与暂存区分别返回对应差异",
		{ skip: !HAS_GIT },
		() => {
			const root = repository();
			writeFileSync(join(root, "a.txt"), "old\n");
			git(root, ["add", "a.txt"]);
			git(root, ["commit", "-m", "init"]);

			writeFileSync(join(root, "a.txt"), "new\n");
			const worktree = gitDiff(root, "a.txt", false);
			assert.match(worktree ?? "", /-old/);
			assert.match(worktree ?? "", /\+new/);

			writeFileSync(join(root, "c.txt"), "staged\n");
			git(root, ["add", "c.txt"]);
			const staged = gitDiff(root, "c.txt", true);
			assert.match(staged ?? "", /\+staged/);
		},
	);

	it("不是仓库时返回 undefined", () => {
		const root = mkdtempSync(join(tmpdir(), "reins-git-"));
		dirs.push(root);
		assert.equal(gitStatus(root), undefined);
	});
});
