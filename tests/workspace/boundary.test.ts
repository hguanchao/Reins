import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isPathInside, resolveRealPath, WorkspaceBoundary } from "#src/workspace/boundary.ts";

describe("路径在根内", () => {
	it("根自身算在根内", () => {
		assert.equal(isPathInside("E:\\w", "E:\\w"), true);
	});

	it("根内的路径算在根内", () => {
		assert.equal(isPathInside("E:\\w", "E:\\w\\a.ts"), true);
		assert.equal(isPathInside("E:\\w", "E:\\w\\sub\\a.ts"), true);
	});

	it("根外与同级目录算在根外", () => {
		assert.equal(isPathInside("E:\\w", "E:\\other\\a.ts"), false);
		assert.equal(isPathInside("E:\\w", "E:\\other"), false);
	});

	it("以 .. 开头的文件名不误伤", () => {
		// E:\w\..name 是根内的普通文件，名字以 .. 起头
		assert.equal(isPathInside("E:\\w", "E:\\w\\..name"), true);
		// E:\w\.. 才是跳出
		assert.equal(isPathInside("E:\\w", "E:\\w\\.."), false);
	});

	it("路径前缀相同但目录名更长的不算", () => {
		assert.equal(isPathInside("E:\\w", "E:\\work\\a.ts"), false);
	});
});

describe("真实路径解析", () => {
	it("解析目录链接，目标文件不存在时也取真实父路径", (t) => {
		const directory = mkdtempSync(join(tmpdir(), "reins-boundary-"));
		try {
			const root = join(directory, "root");
			const outside = join(directory, "outside");
			mkdirSync(root);
			mkdirSync(outside);
			const link = join(root, "link");
			try {
				symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
			} catch {
				t.skip("symlinks are not available in this environment");
				return;
			}

			const resolved = resolveRealPath(join(link, "a.ts"));
			assert.equal(resolved, join(realpathSync(outside), "a.ts"));
			assert.equal(isPathInside(realpathSync(root), resolved), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("悬空符号链接解析到目标位置，而不是链接自身", (t) => {
		const directory = mkdtempSync(join(tmpdir(), "reins-boundary-"));
		try {
			const root = join(directory, "root");
			const outside = join(directory, "outside");
			mkdirSync(root);
			mkdirSync(outside);
			const target = join(outside, "not-created-yet.txt");
			const link = join(root, "dangling");
			try {
				symlinkSync(target, link, "file");
			} catch {
				t.skip("symlinks are not available in this environment");
				return;
			}

			const resolved = resolveRealPath(link);
			// 若返回 root/dangling，沙箱会认为「字面路径在根内」而放行，写操作就会跟随链接落到根外
			assert.equal(isPathInside(realpathSync(root), resolved), false);
			assert.equal(resolved.endsWith("not-created-yet.txt"), true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("悬空链接指向根内时仍判为根内", (t) => {
		const directory = mkdtempSync(join(tmpdir(), "reins-boundary-"));
		try {
			const root = join(directory, "root");
			mkdirSync(root);
			const link = join(root, "inner");
			try {
				symlinkSync(join(root, "missing.txt"), link, "file");
			} catch {
				t.skip("symlinks are not available in this environment");
				return;
			}

			assert.equal(isPathInside(realpathSync(root), resolveRealPath(link)), true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("工作区路径边界", () => {
	const boundary = new WorkspaceBoundary("E:\\w");

	it("resolve 把相对路径并进根，并判断是否在根内", () => {
		const inside = boundary.resolve("a.ts");
		assert.equal(inside.insideRoot, true);
		assert.equal(inside.absolute.endsWith("a.ts"), true);

		const outside = boundary.resolve("..\\outside.txt");
		assert.equal(outside.insideRoot, false);
	});

	it("display 给出相对路径，分隔符统一成 /", () => {
		assert.equal(boundary.display("E:\\w\\sub\\a.ts"), "sub/a.ts");
		assert.equal(boundary.display("E:\\w"), ".");
	});

	it("display 对根外路径原样返回", () => {
		assert.equal(boundary.display("E:\\other\\a.ts"), "E:\\other\\a.ts");
	});
});
