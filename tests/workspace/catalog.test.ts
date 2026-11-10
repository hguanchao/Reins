import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
	dropWorkspace,
	listKnownWorkspaces,
	listWorkspaces,
	registerWorkspace,
	registeredWorkspace,
	rebuildCatalogFromSessions,
	unregisterWorkspace,
} from "#src/workspace/catalog.ts";

/**
 * 清单落在 REINS_HOME 下；每个用例用自己的临时主目录，登记的目录也建在它里面，
 * 免得用例之间通过共享的 workspaces.json 互相影响。
 */
async function withHomes(run: (home: string, project: (name: string) => string) => Promise<void>): Promise<void> {
	const home = join(tmpdir(), `reins-catalog-${Math.random().toString(16).slice(2)}`);
	const previous = process.env["REINS_HOME"];
	process.env["REINS_HOME"] = home;
	mkdirSync(home, { recursive: true });

	try {
		await run(home, (name) => {
			const directory = join(home, name);
			mkdirSync(directory, { recursive: true });
			return resolve(directory);
		});
	} finally {
		if (previous === undefined) delete process.env["REINS_HOME"];
		else process.env["REINS_HOME"] = previous;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("项目登记清单", () => {
	it("登记后能列出，重复登记不产生第二条", async () => {
		await withHomes(async (home, project) => {
			const alpha = project("alpha");
			assert.equal(registerWorkspace(alpha), resolve(alpha));
			assert.equal(registerWorkspace(alpha), resolve(alpha));
			assert.deepEqual(listWorkspaces(), [resolve(alpha)]);
			assert.equal(registeredWorkspace(alpha), resolve(alpha));
			// 同一路径换个写法也不能多出一条
			registerWorkspace(join(home, "alpha"));
			assert.equal(listWorkspaces().length, 1);
		});
	});

	it("从列表移除只改可见性，历史查找路径仍保留", async () => {
		await withHomes(async (_home, project) => {
			const alpha = project("alpha");
			const beta = project("beta");
			registerWorkspace(alpha);
			registerWorkspace(beta);

			assert.equal(unregisterWorkspace(alpha), true);
			assert.deepEqual(listWorkspaces(), [resolve(beta)]);
			// 移除的项目其历史任务还要能查到，所以路径本身仍在清单里
			assert.deepEqual(listKnownWorkspaces(), [resolve(alpha), resolve(beta)]);
			assert.equal(registeredWorkspace(alpha), undefined);
			// 再登记一次是把条目恢复成可见，不是追加
			registerWorkspace(alpha);
			assert.deepEqual(listWorkspaces(), [resolve(alpha), resolve(beta)]);
		});
	});

	it("删除项目连隐藏记录一起从清单里去掉", async () => {
		await withHomes(async (_home, project) => {
			const alpha = project("alpha");
			const beta = project("beta");
			registerWorkspace(alpha);
			registerWorkspace(beta);
			unregisterWorkspace(alpha);

			assert.equal(dropWorkspace(beta), true);
			assert.deepEqual(listKnownWorkspaces(), [resolve(alpha)]);

			// 被移除过的条目也是同一项目的记录：删除要把它一并清掉，不留指向空目录的查找路径
			assert.equal(dropWorkspace(alpha), true);
			assert.deepEqual(listKnownWorkspaces(), []);
		});
	});

	it("重复隐藏或未登记路径都报告未改动，界面据此不会误报成功", async () => {
		await withHomes(async (_home, project) => {
			const alpha = project("alpha");
			registerWorkspace(alpha);
			assert.equal(unregisterWorkspace(alpha), true);
			assert.equal(unregisterWorkspace(alpha), false);
			assert.equal(unregisterWorkspace(project("beta")), false);
			assert.deepEqual(listWorkspaces(), []);
		});
	});

	it("没登记过的路径删除时报告未改动", async () => {
		await withHomes(async (_home, project) => {
			registerWorkspace(project("alpha"));
			assert.equal(dropWorkspace(project("beta")), false);
			assert.equal(dropWorkspace(join(_home, "gone", "nowhere")), false);
			assert.deepEqual(listKnownWorkspaces().length, 1);
		});
	});
});

/**
 * 清单丢得起：会话目录名带哈希，反推不出路径，但会话文件头里还留着 cwd，
 * 启动时据此就能把根找回来。
 */
describe("清单按会话重建", () => {
	const writeSession = (home: string, name: string, cwd: string, archived = false): void => {
		const directory = join(home, "sessions", name, archived ? "archived" : "");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "2026-11-02T12-03-50-403Z_870dd77a.jsonl"), `${JSON.stringify({ type: "session", version: 1, id: name, cwd })}\n`);
	};

	it("清单为空时按活动会话补回可见条目", async () => {
		await withHomes(async (home, project) => {
			const alpha = project("alpha");
			writeSession(home, "alpha-dir", alpha);
			assert.equal(rebuildCatalogFromSessions(), 1);
			assert.deepEqual(listWorkspaces(), [resolve(alpha)]);
		});
	});

	it("桌面落地目录不算项目，有活动会话也不补进清单", async () => {
		await withHomes(async (home, project) => {
			const scratch = project("scratch");
			const alpha = project("alpha");
			writeSession(home, "scratch-dir", scratch);
			writeSession(home, "alpha-dir", alpha);
			assert.equal(rebuildCatalogFromSessions(scratch), 1);
			assert.deepEqual(listWorkspaces(), [resolve(alpha)]);
			assert.deepEqual(listKnownWorkspaces(), [resolve(alpha)]);
		});
	});

	it("只有归档会话的目录补成隐藏，路径仍可查", async () => {
		await withHomes(async (home, project) => {
			const alpha = project("alpha");
			writeSession(home, "alpha-dir", alpha, true);
			assert.equal(rebuildCatalogFromSessions(), 1);
			assert.deepEqual(listWorkspaces(), []);
			assert.deepEqual(listKnownWorkspaces(), [resolve(alpha)]);
		});
	});

	it("已有条目不动，被移除的项目不会重新冒出来", async () => {
		await withHomes(async (home, project) => {
			const alpha = project("alpha");
			registerWorkspace(alpha);
			unregisterWorkspace(alpha);
			writeSession(home, "alpha-dir", alpha);
			assert.equal(rebuildCatalogFromSessions(), 0);
			assert.deepEqual(listWorkspaces(), []);
			assert.deepEqual(listKnownWorkspaces(), [resolve(alpha)]);
		});
	});

	it("换种路径写法也只算同一条", async () => {
		await withHomes(async (home, project) => {
			const alpha = project("alpha");
			registerWorkspace(alpha);
			writeSession(home, "alpha-dir", `${alpha.toLowerCase()}${process.platform === "win32" ? "" : ""}`);
			const before = listKnownWorkspaces().length;
			rebuildCatalogFromSessions();
			assert.equal(listKnownWorkspaces().length, before);
		});
	});

	it("目录已被删掉的会话跳过，清单损坏时按空清单自愈", async () => {
		await withHomes(async (home, project) => {
			const alpha = project("alpha");
			writeSession(home, "gone-dir", join(home, "已经不存在"));
			writeFileSync(join(home, "workspaces.json"), "{ 坏掉的 json");
			assert.equal(rebuildCatalogFromSessions(), 0);
			assert.deepEqual(listKnownWorkspaces(), []);

			writeSession(home, "alpha-dir", alpha);
			assert.equal(rebuildCatalogFromSessions(), 1);
			assert.deepEqual(listWorkspaces(), [resolve(alpha)]);
		});
	});
});
