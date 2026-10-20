import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import { fileEntries, walk } from "../../../src/plugins/tools-plugin/walk.ts";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function withTree(test: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "reins-walk-"));
	try {
		writeFileSync(join(root, "file.txt"), "x");
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "inside.txt"), "x");
		test(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function link(target: string, path: string): boolean {
	try {
		symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch {
		return false;
	}
}

describe("目录遍历", () => {
	it("跳过符号链接，不进入链接目标", (t) => {
		withTree((root) => {
			if (!link(join(root, "real"), join(root, "link"))) {
				t.skip("symlinks are not available in this environment");
				return;
			}

			const entries = [...walk(root, { maxEntries: 100 })];
			const paths = entries.map((entry) => entry.relative);
			assert.ok(paths.includes("real/inside.txt"));
			assert.ok(paths.every((path) => !path.startsWith("link")));
		});
	});

	it("指向自身的链接不会让遍历无限展开", (t) => {
		withTree((root) => {
			if (!link(root, join(root, "loop"))) {
				t.skip("symlinks are not available in this environment");
				return;
			}

			const entries = [...walk(root, { maxEntries: 1000 })];
			assert.ok(entries.length > 0);
			assert.ok(entries.every((entry) => relative(root, entry.absolute) !== "loop"));
		});
	});

	it("git 仓库里按 .gitignore 过滤", (t) => {
		if (!hasGit()) {
			t.skip("git is not available in this environment");
			return;
		}

		const root = mkdtempSync(join(tmpdir(), "reins-walk-git-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
			writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(root, "a.txt"), "x");
			writeFileSync(join(root, "ignored.txt"), "x");

			const paths = [...fileEntries(root, 1000)].map((entry) => entry.relative);
			assert.ok(paths.includes("a.txt"));
			assert.equal(paths.includes("ignored.txt"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("非 git 目录回退到普通遍历", () => {
		withTree((root) => {
			const paths = [...fileEntries(root, 100)].map((entry) => entry.relative);
			assert.ok(paths.includes("real/inside.txt"));
		});
	});
});
