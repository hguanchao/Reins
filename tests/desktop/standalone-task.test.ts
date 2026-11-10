import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createStandaloneTaskRunner, defaultUnboundDir } from "#desktop/standalone-task.ts";
import { listWorkspaces } from "#src/workspace/catalog.ts";
import { standaloneRoot } from "#src/workspace/standalone.ts";

const originalHome = process.env.REINS_HOME;
let home: string | undefined;

/** 每个用例独立的配置主目录；切换能力默认成功，可注入延迟或失败。 */
function fixture(
	unboundDir: () => string = defaultUnboundDir,
	switchTo?: (path: string) => Promise<boolean>,
): {
	readonly runner: () => Promise<boolean>;
	readonly calls: readonly string[];
} {
	home = mkdtempSync(join(tmpdir(), "reins-unbound-"));
	process.env.REINS_HOME = home;
	const calls: string[] = [];
	const runner = createStandaloneTaskRunner({
		unboundDir,
		switchTo: (path) => {
			calls.push(path);
			return switchTo === undefined ? Promise.resolve(true) : switchTo(path);
		},
	});
	return { runner, calls };
}

afterEach(() => {
	if (originalHome === undefined) delete process.env.REINS_HOME;
	else process.env.REINS_HOME = originalHome;
	if (home !== undefined) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

describe("新建任务编排", () => {
	it("新任务落一块自管空地，不登记成项目", async () => {
		const f = fixture();
		assert.equal(await f.runner(), true);
		assert.equal(f.calls.length, 1);
		assert.ok((f.calls[0] ?? "").startsWith(realpathSync(standaloneRoot())));
		assert.deepEqual(listWorkspaces(), []);
	});

	it("连点复用同一次在建任务，只开一块目录", async () => {
		let release: ((ok: boolean) => void) | undefined;
		const f = fixture(defaultUnboundDir, () => new Promise<boolean>((resolve) => {
			release = resolve;
		}));
		const first = f.runner();
		const second = f.runner();
		assert.equal(first, second);
		release?.(true);
		assert.equal(await first, true);
		assert.equal(await second, true);
		assert.equal(f.calls.length, 1);
		assert.equal(readdirSync(realpathSync(standaloneRoot())).length, 1);
	});

	it("切换失败收回刚建的空地", async () => {
		const f = fixture(defaultUnboundDir, () => Promise.resolve(false));
		assert.equal(await f.runner(), false);
		assert.deepEqual(listWorkspaces(), []);
		assert.equal(readdirSync(realpathSync(standaloneRoot())).length, 0);
	});

	it("空地建不出来时直接失败，不触发切换", async () => {
		const f = fixture(() => {
			throw new Error("磁盘已满");
		});
		assert.equal(await f.runner(), false);
		assert.equal(f.calls.length, 0);
	});
});