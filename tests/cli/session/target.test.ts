import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createSession, forkSession, resumeCommand, resumeSession } from "../../../src/cli/session/target.ts";
import { sessionsDir } from "../../../src/config/paths.ts";
import { JsonlSessionStore } from "../../../src/plugins/session-plugin/jsonl-store.ts";

/** 会话目录由 REINS_HOME 决定；每个用例用自己的临时目录，结束后恢复并删除。 */
async function withHome(run: (workRoot: string) => Promise<void>): Promise<void> {
	const home = join(tmpdir(), `reins-target-${Math.random().toString(16).slice(2)}`);
	const previous = process.env["REINS_HOME"];
	process.env["REINS_HOME"] = home;
	const workRoot = join(home, "work");
	mkdirSync(workRoot, { recursive: true });

	try {
		await run(workRoot);
	} finally {
		if (previous === undefined) delete process.env["REINS_HOME"];
		else process.env["REINS_HOME"] = previous;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("会话接续", () => {
	it("退出命令带着会话标识", () => {
		assert.equal(resumeCommand("abc123"), "reins --resume abc123");
	});

	it("按标识找回已落盘的会话", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			const created = createSession(workRoot, store);
			created.begin();
			await created.close();

			const resumed = resumeSession(workRoot, created.id, store);
			assert.equal(resumed.id, created.id);
			assert.equal(resumed.entryCount, 0);
			await resumed.close();
		});
	});

	it("标识不存在时明确报错", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			assert.throws(() => resumeSession(workRoot, "missing", store), /not found/);
		});
	});

	it("从当前末尾分叉：复制对话路径、记录来源、原会话不受影响", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			const source = createSession(workRoot, store);
			await source.append({ type: "message", message: { role: "user", content: "first" } });
			await source.append({ type: "message", message: { role: "user", content: "second" } });
			const leaf = source.leafId;

			const forked = forkSession(source, workRoot, store);
			assert.notEqual(forked.id, source.id);
			assert.equal(forked.entryCount, 2);
			assert.equal(forked.leafId, leaf);

			const listing = store
				.list(sessionsDir(workRoot))
				.find((item) => item.id === forked.id);
			assert.deepEqual(listing?.forkedFrom, { session: source.id, entry: leaf });

			// 两个会话之后各写各的
			await forked.append({ type: "message", message: { role: "user", content: "fork work" } });
			assert.equal(source.entryCount, 2);
			assert.equal(forked.entryCount, 3);

			await forked.close();
			await source.close();
		});
	});

	it("空会话没有分叉点", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			const source = createSession(workRoot, store);
			assert.throws(() => forkSession(source, workRoot, store), /no entries to fork from/);
			await source.close();
		});
	});
});
