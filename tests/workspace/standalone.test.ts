import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
	createStandaloneDir,
	isStandalonePath,
	listStandaloneDirs,
	releaseStandaloneDir,
	standaloneRoot,
} from "#src/workspace/standalone.ts";

const home = mkdtempSync(join(tmpdir(), "reins-standalone-"));
process.env["REINS_HOME"] = home;

beforeEach(() => {
	rmSync(join(home, "workspaces"), { recursive: true, force: true });
});

after(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("独立任务目录", () => {
	it("按时刻命名并落在配置目录的 workspaces 下", () => {
		const created = createStandaloneDir(new Date(2026, 10, 9, 8, 7, 6));
		assert.equal(standaloneRoot(), join(home, "workspaces"));
		assert.equal(created.path, join(home, "workspaces", "standalone-20261109-080706"));
		assert.equal(created.label, "11-09 08:07");
		assert.deepEqual(readdirSync(created.path), []);
	});

	it("同一秒重复创建让开后缀，不共用目录", () => {
		const now = new Date(2026, 10, 9, 8, 7, 6);
		const first = createStandaloneDir(now);
		const second = createStandaloneDir(now);
		assert.notEqual(first.path, second.path);
		assert.equal(second.path, `${first.path}-2`);
	});

	it("只认根内的路径", () => {
		const created = createStandaloneDir();
		assert.equal(isStandalonePath(created.path), true);
		assert.equal(isStandalonePath(standaloneRoot()), true);
		assert.equal(isStandalonePath(join(home, "别的目录")), false);
		assert.equal(isStandalonePath(join(standaloneRoot(), "..", "逃出去")), false);
	});

	it("空目录才回收，有内容原样保留", () => {
		const empty = createStandaloneDir();
		assert.equal(releaseStandaloneDir(empty.path), true);

		const used = createStandaloneDir();
		mkdirSync(join(used.path, "src"));
		assert.equal(releaseStandaloneDir(used.path), false);

		const withFile = createStandaloneDir();
		writeFileSync(join(withFile.path, "notes.md"), "x");
		assert.equal(releaseStandaloneDir(withFile.path), false);
	});

	it("根外路径与不存在的路径回收返回 false", () => {
		assert.equal(releaseStandaloneDir(""), false);
		assert.equal(releaseStandaloneDir(join(home, "没有这个目录")), false);
	});

	it("列出全部空地，根不存在时为空", () => {
		assert.deepEqual(listStandaloneDirs(), []);
		const first = createStandaloneDir();
		const second = createStandaloneDir();
		assert.deepEqual([...listStandaloneDirs()].sort(), [first.path, second.path].sort());
	});
});
