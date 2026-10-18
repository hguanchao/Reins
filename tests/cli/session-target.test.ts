import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createSession, resumeCommand, resumeSession } from "../../src/cli/session-target.ts";
import { JsonlSessionStore } from "../../src/plugins/session-plugin/jsonl-store.ts";

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
});
