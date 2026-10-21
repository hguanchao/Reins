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
	it("按 .gitignore 过滤，且始终不进入 .git", () => {
		withTree((root) => {
			mkdirSync(join(root, "node_modules"));
			writeFileSync(join(root, "node_modules", "skip.js"), "x");
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, ".git", "HEAD"), "x");
			writeFileSync(join(root, "debug.log"), "x");
			writeFileSync(join(root, ".gitignore"), "node_modules\ndebug.log\n");

			const paths = [...walk(root, { maxEntries: 200 })].map((entry) => entry.relative);

			assert.ok(paths.includes("real/inside.txt"));
			assert.equal(paths.some((path) => path.startsWith("node_modules")), false);
			assert.equal(paths.includes("debug.log"), false);
			// .git 不靠 .gitignore：任何仓库都不会把自己的版本库目录写进忽略规则
			assert.equal(paths.some((path) => path.startsWith(".git/")), false);
		});
	});

	it("没有 .gitignore 时不跳过任何目录", () => {
		withTree((root) => {
			mkdirSync(join(root, "node_modules"));
			writeFileSync(join(root, "node_modules", "keep.js"), "x");

			const paths = [...walk(root, { maxEntries: 200 })].map((entry) => entry.relative);

			assert.ok(paths.includes("node_modules/keep.js"));
		});
	});

	it("子目录的 .gitignore 只作用于它自己那层", () => {
		withTree((root) => {
			mkdirSync(join(root, "a"));
			mkdirSync(join(root, "b"));
			writeFileSync(join(root, "a", ".gitignore"), "*.tmp\n");
			writeFileSync(join(root, "a", "x.tmp"), "x");
			writeFileSync(join(root, "b", "x.tmp"), "x");

			const paths = [...walk(root, { maxEntries: 200 })].map((entry) => entry.relative);

			assert.equal(paths.includes("a/x.tmp"), false);
			assert.ok(paths.includes("b/x.tmp"));
		});
	});

	it("祖先目录的 .gitignore 生效，到仓库根为止", () => {
		const outer = mkdtempSync(join(tmpdir(), "reins-walk-parent-"));
		try {
			const repo = join(outer, "repo");
			const sub = join(repo, "sub");
			mkdirSync(sub, { recursive: true });
			mkdirSync(join(repo, ".git"));
			writeFileSync(join(repo, ".gitignore"), "*.log\n");
			writeFileSync(join(outer, ".gitignore"), "b.txt\n");
			writeFileSync(join(sub, "a.log"), "x");
			writeFileSync(join(sub, "b.txt"), "x");

			const paths = [...walk(sub, { maxEntries: 100 })].map((entry) => entry.relative);

			// 仓库根的规则对子目录生效
			assert.equal(paths.includes("a.log"), false);
			// 仓库根之上（outer）的规则不该再影响这个项目
			assert.ok(paths.includes("b.txt"));
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

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
