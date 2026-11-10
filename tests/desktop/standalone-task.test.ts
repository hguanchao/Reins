import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createStandaloneTaskRunner } from "#desktop/standalone-task.ts";
import { listWorkspaces, unregisterWorkspace } from "#src/workspace/catalog.ts";
import { workspaceNameOf } from "#src/workspace/name.ts";
import { standaloneRoot } from "#src/workspace/standalone.ts";

const originalHome = process.env.REINS_HOME;
let home: string | undefined;

/** 每个用例独立的配置主目录；切换能力默认成功，可注入延迟或失败。 */
function fixture(switchTo?: (path: string) => Promise<boolean>): {
	readonly runner: () => Promise<boolean>;
	readonly calls: readonly string[];
	readonly namesFile: string;
	readonly setCurrent: (path: string | undefined) => void;
} {
	home = mkdtempSync(join(tmpdir(), "reins-standalone-"));
	process.env.REINS_HOME = home;
	const namesFile = join(home, "names.json");
	const calls: string[] = [];
	let current: string | undefined;
	const runner = createStandaloneTaskRunner({
		currentWorkspace: () => current,
		switchTo: (path) => {
			calls.push(path);
			return switchTo === undefined ? Promise.resolve(true) : switchTo(path);
		},
		namesFile,
	});
	return {
		runner,
		calls,
		namesFile,
		setCurrent: (path) => {
			current = path;
		},
	};
}

afterEach(() => {
	if (originalHome === undefined) delete process.env.REINS_HOME;
	else process.env.REINS_HOME = originalHome;
	if (home !== undefined) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

describe("新建独立任务编排", () => {
	it("不在独立任务里时新开一块地并写显示名", async () => {
		const f = fixture();
		assert.equal(await f.runner(), true);
		assert.equal(f.calls.length, 1);
		const entries = listWorkspaces();
		assert.equal(entries.length, 1);
		const root = entries[0] ?? "";
		assert.ok(root.startsWith(realpathSync(standaloneRoot())));
		assert.ok(existsSync(root));
		assert.ok((workspaceNameOf(f.namesFile, root) ?? "").startsWith("独立任务 "));
	});

	it("连点复用同一次在建任务，只开一块目录", async () => {
		let release: ((ok: boolean) => void) | undefined;
		const f = fixture(() => new Promise<boolean>((resolve) => {
			release = resolve;
		}));
		const first = f.runner();
		const second = f.runner();
		assert.equal(first, second);
		release?.(true);
		assert.equal(await first, true);
		assert.equal(await second, true);
		assert.equal(f.calls.length, 1);
		assert.equal(listWorkspaces().length, 1);
	});

	it("已停在登记中的独立任务里时复用同一块地", async () => {
		const f = fixture();
		await f.runner();
		const existing = listWorkspaces()[0] ?? "";
		f.setCurrent(existing);

		assert.equal(await f.runner(), true);
		assert.equal(f.calls.length, 2);
		assert.equal(f.calls[1], existing);
		assert.equal(listWorkspaces().length, 1);
		assert.equal(readdirSync(realpathSync(standaloneRoot())).length, 1);
	});

	it("已从侧栏移除的独立任务不复用，另开新地", async () => {
		const f = fixture();
		await f.runner();
		const existing = listWorkspaces()[0] ?? "";
		assert.equal(unregisterWorkspace(existing), true);
		f.setCurrent(existing);

		assert.equal(await f.runner(), true);
		assert.notEqual(f.calls[1], existing);
		assert.equal(listWorkspaces().length, 1);
		assert.equal(readdirSync(realpathSync(standaloneRoot())).length, 2);
	});

	it("切换失败收回目录与登记，下一次点击仍可用", async () => {
		let ok = false;
		const f = fixture(() => Promise.resolve(ok));
		assert.equal(await f.runner(), false);
		assert.deepEqual(listWorkspaces(), []);
		assert.equal(readdirSync(realpathSync(standaloneRoot())).length, 0);

		ok = true;
		assert.equal(await f.runner(), true);
		assert.equal(listWorkspaces().length, 1);
	});
});