import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createDesktopPaths, type DesktopPaths } from "#desktop/paths.ts";
import {
	lastWorkspace,
	rememberWorkspace,
	resolveStartupWorkspace,
} from "#desktop/startup-workspace.ts";
import {
	dropWorkspace,
	listKnownWorkspaces,
	listWorkspaces,
	registerWorkspace,
	unregisterWorkspace,
} from "#src/workspace/catalog.ts";

const originalHome = process.env.REINS_HOME;
const originalOverride = process.env.REINS_WORKSPACE;

function fixture(): { readonly paths: DesktopPaths; readonly fallback: string } {
	const paths = createDesktopPaths(
		"build",
		mkdtempSync(join(tmpdir(), "reins-userdata-")),
	);
	process.env.REINS_HOME = mkdtempSync(join(tmpdir(), "reins-home-"));
	delete process.env.REINS_WORKSPACE;
	return { paths, fallback: paths.userData("workspace") };
}

function projectDir(): string {
	return mkdtempSync(join(tmpdir(), "reins-project-"));
}

/** Windows 路径大小写与真实路径解析都可能让字面比较失真。 */
const key = (path: string): string => path.toLowerCase();

afterEach(() => {
	if (originalHome === undefined) delete process.env.REINS_HOME;
	else process.env.REINS_HOME = originalHome;
	if (originalOverride === undefined) delete process.env.REINS_WORKSPACE;
	else process.env.REINS_WORKSPACE = originalOverride;
});

describe("启动工作区解析", () => {
	it("首次启动落到自管空目录，但不登记成项目", () => {
		const { paths, fallback } = fixture();
		const resolved = resolveStartupWorkspace(paths);
		assert.equal(key(resolved), key(realpathSync(fallback)));
		assert.deepEqual(listWorkspaces(), []);
		assert.deepEqual(listKnownWorkspaces(), []);
		assert.equal(lastWorkspace(paths), undefined);
	});

	it("上次目录仍在登记表时原样恢复", () => {
		const { paths } = fixture();
		const canonical = registerWorkspace(projectDir());
		rememberWorkspace(paths, canonical);
		assert.equal(key(resolveStartupWorkspace(paths)), key(canonical));
		assert.deepEqual(listWorkspaces().map(key), [key(canonical)]);
	});

	it("上次目录被移除后不再复活，改落自管空目录", () => {
		const { paths, fallback } = fixture();
		const canonical = registerWorkspace(projectDir());
		rememberWorkspace(paths, canonical);
		assert.equal(dropWorkspace(canonical), true);

		const resolved = resolveStartupWorkspace(paths);
		assert.notEqual(key(resolved), key(canonical));
		assert.equal(key(resolved), key(realpathSync(fallback)));
		assert.deepEqual(listWorkspaces(), []);
		assert.deepEqual(listKnownWorkspaces(), []);
	});

	it("从侧栏移除的工作区不再作为启动目录，但历史查找路径仍保留", () => {
		const { paths, fallback } = fixture();
		const canonical = registerWorkspace(projectDir());
		assert.equal(unregisterWorkspace(canonical), true);
		rememberWorkspace(paths, canonical);

		const resolved = resolveStartupWorkspace(paths);
		assert.equal(key(resolved), key(realpathSync(fallback)));
		assert.notEqual(key(resolved), key(canonical));
		assert.deepEqual(listWorkspaces(), []);
		assert.ok(listKnownWorkspaces().some((path) => key(path) === key(canonical)));
	});

	it("旧版误登记的落地目录在启动时清掉", () => {
		const { paths, fallback } = fixture();
		mkdirSync(fallback, { recursive: true });
		const canonical = registerWorkspace(fallback);
		rememberWorkspace(paths, canonical);

		const resolved = resolveStartupWorkspace(paths);
		assert.equal(key(resolved), key(canonical));
		assert.deepEqual(listWorkspaces(), []);
		assert.deepEqual(listKnownWorkspaces(), []);
	});

	it("环境变量覆盖优先于上次记忆", () => {
		const { paths } = fixture();
		const canonical = registerWorkspace(projectDir());
		rememberWorkspace(paths, canonical);
		const override = projectDir();
		process.env.REINS_WORKSPACE = override;
		const resolved = resolveStartupWorkspace(paths);
		assert.equal(key(resolved), key(realpathSync(override)));
		assert.notEqual(key(resolved), key(canonical));
		assert.equal(listWorkspaces().length, 2);
	});
});
