import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CheckpointService } from "../../src/checkpoint/checkpoints.ts";

const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(): { readonly work: string; readonly storage: string } {
	const root = mkdtempSync(join(tmpdir(), "reins-checkpoints-"));
	roots.push(root);
	const work = join(root, "work");
	mkdirSync(work);
	execFileSync("git", ["init", "--quiet", work], { windowsHide: true });
	writeFileSync(join(work, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(work, "ignored.txt"), "ignore me\n");
	return { work, storage: join(root, "store") };
}

function write(work: string, name: string, content: string): void {
	writeFileSync(join(work, name), content);
}

describe("检查点与撤销", () => {
	it("抓取、预览并恢复工作区，保留安全检查点", async () => {
		const { work, storage } = workspace();
		let notice: string | undefined;
		const service = new CheckpointService({
			workRoot: work,
			sessionId: "s1",
			storageDir: storage,
			onUndo: (message) => {
				notice = message;
			},
		});
		assert.equal(await service.init(), true);
		assert.equal(service.available, true);

		write(work, "keep.txt", "one\n");
		write(work, "gone.txt", "bye\n");
		const turn = await service.captureTurn();
		assert.ok(turn);
		assert.equal(turn?.label, "Turn 1");

		write(work, "keep.txt", "two\n");
		write(work, "new.txt", "new\n");
		rmSync(join(work, "gone.txt"));
		write(work, "ignored.txt", "changed but ignored\n");
		await service.finalizeTurn(turn?.id);

		const entries = service.list();
		assert.equal(entries[0]?.id, turn?.id);
		assert.equal(entries[0]?.changes, 3);

		const preview = await service.preview(turn?.id ?? "");
		assert.deepEqual(
			preview.changes.map((change) => [change.path, change.status]),
			[
				["gone.txt", "deleted"],
				["keep.txt", "modified"],
				["new.txt", "added"],
			],
		);

		const result = await service.restore(turn?.id ?? "");
		assert.equal(result.restored, 2);
		assert.equal(result.removed, 1);
		assert.equal(result.safety.kind, "safety");
		assert.equal(readFileSync(join(work, "keep.txt"), "utf8"), "one\n");
		assert.equal(readFileSync(join(work, "gone.txt"), "utf8"), "bye\n");
		assert.equal(readFileSync(join(work, "ignored.txt"), "utf8"), "changed but ignored\n");
		assert.throws(() => readFileSync(join(work, "new.txt")));
		assert.ok(notice?.includes("restored Turn 1"));

		const afterUndo = service.list();
		assert.equal(afterUndo.some((entry) => entry.kind === "safety"), true);
		assert.equal(await service.latestUndoable(), undefined);

		// 安全检查点可以撤销这次撤销
		await service.restore(result.safety.id);
		assert.equal(readFileSync(join(work, "keep.txt"), "utf8"), "two\n");
		assert.equal(readFileSync(join(work, "new.txt"), "utf8"), "new\n");
		assert.throws(() => readFileSync(join(work, "gone.txt")));
	});

	it("检查点索引按会话持久化，重新打开后仍能列出", async () => {
		const { work, storage } = workspace();
		const first = new CheckpointService({ workRoot: work, sessionId: "s1", storageDir: storage });
		assert.equal(await first.init(), true);
		write(work, "a.txt", "a\n");
		await first.captureTurn();
		const entries = first.list();
		assert.equal(entries.length, 1);

		const second = new CheckpointService({ workRoot: work, sessionId: "s1", storageDir: storage });
		assert.equal(await second.init(), true);
		assert.equal(second.list().length, 1);
		assert.equal(second.list()[0]?.label, "Turn 1");

		const other = new CheckpointService({ workRoot: work, sessionId: "s2", storageDir: storage });
		assert.equal(await other.init(), true);
		assert.equal(other.list().length, 0);
	});

	it("非 git 仓库明确不可用，不创建半套快照", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-checkpoints-nogit-"));
		roots.push(root);
		const work = join(root, "work");
		mkdirSync(work);
		const service = new CheckpointService({
			workRoot: work,
			sessionId: "s1",
			storageDir: join(root, "store"),
		});
		assert.equal(await service.init(), false);
		assert.equal(service.available, false);
		assert.match(service.lastError ?? "", /Git repository/);
		assert.equal(await service.captureTurn(), undefined);
	});
});
