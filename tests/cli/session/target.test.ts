import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	archiveSessions,
	createSession,
	deleteSessions,
	deleteSessionsAcross,
	forkSession,
	listArchivedSessions,
	listSessions,
	listSessionsAcross,
	resumeCommand,
	resumeSession,
} from "#src/cli/session/target.ts";
import { sessionsDir } from "#src/config/paths.ts";
import { JsonlSessionStore } from "#src/session/jsonl-store.ts";

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

describe("会话删除", () => {
	it("活动与归档两处一起删，skip 里的会话不动", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			const keep = createSession(workRoot, store);
			const active = createSession(workRoot, store);
			const archived = createSession(workRoot, store);
			for (const session of [keep, active, archived]) {
				await session.append({ type: "message", message: { role: "user", content: "内容" } });
				await session.close();
			}
			assert.equal(archiveSessions(workRoot, store, [archived.id], []), 1);

			const deleted = deleteSessions(workRoot, store, [active.id, archived.id], [keep.id]);
			assert.equal(deleted, 2);
			assert.deepEqual(
				listSessions(workRoot, store).map((item) => item.id),
				[keep.id],
			);
			// 归档文件也得跟着没：否则界面上「永久删除」按下去只是把活动目录扫了一遍
			assert.deepEqual(listArchivedSessions(workRoot, store), []);
		});
	});

	it("跨项目删除：会话文件记在各自项目目录下也能删到", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			const sibling = join(workRoot, "..", `sibling-${Math.random().toString(16).slice(2)}`);
			mkdirSync(sibling, { recursive: true });
			const inWorkRoot = createSession(workRoot, store);
			const inSibling = createSession(sibling, store);
			for (const session of [inWorkRoot, inSibling]) {
				await session.append({ type: "message", message: { role: "user", content: "内容" } });
				await session.close();
			}

			// 删除项目传的是会话标识，文件实际躺在哪个项目的目录里由清单决定
			assert.equal(deleteSessionsAcross([workRoot, sibling], store, [inSibling.id], []), 1);
			assert.deepEqual(
				listSessionsAcross([workRoot, sibling], store).map((item) => item.id),
				[inWorkRoot.id],
			);
		});
	});
});
