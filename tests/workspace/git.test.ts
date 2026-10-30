import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { currentBranch } from "#src/workspace/git.ts";

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
