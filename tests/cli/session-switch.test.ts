import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openSessionForSwitch } from "../../src/cli/session-switch.ts";
import { createSession } from "../../src/cli/session-target.ts";
import { JsonlSessionStore } from "../../src/plugins/session-plugin/jsonl-store.ts";

/** 会话目录由 REINS_HOME 决定；每个用例用自己的临时目录，结束后恢复并删除。 */
async function withHome(run: (workRoot: string) => Promise<void>): Promise<void> {
	const home = join(tmpdir(), `reins-switch-${Math.random().toString(16).slice(2)}`);
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

describe("切换会话", () => {
	it("打开目标会话并读出它的对话流", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			const first = createSession(workRoot, store);
			first.begin();
			await first.append({ type: "message", message: { role: "user", content: "first work" } });
			await first.close();

			const second = createSession(workRoot, store);
			second.begin();
			await second.append({ type: "message", message: { role: "user", content: "second work" } });
			await second.close();

			const switched = openSessionForSwitch(workRoot, second.id, store);
			assert.equal(switched.session.id, second.id);
			assert.equal(switched.session.entryCount, 1);
			assert.deepEqual(
				switched.history.map((turn) => turn.prompt),
				["second work"],
			);
			await switched.session.close();
		});
	});

	it("目标会话不存在时明确报错", async () => {
		await withHome(async (workRoot) => {
			const store = new JsonlSessionStore();
			assert.throws(() => openSessionForSwitch(workRoot, "missing", store), /not found/);
		});
	});
});
