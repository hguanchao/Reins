import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseArgs, type CliOptions } from "../../src/cli/args.ts";
import { openSession, resolveListing } from "../../src/cli/session-target.ts";
import { sessionsDir } from "../../src/config/paths.ts";
import { JsonlSessionStore } from "../../src/plugins/session-plugin/jsonl-store.ts";
import { Session } from "../../src/session/session.ts";

/**
 * 这次运行接哪个会话。
 *
 * 接错会话或改到原会话都不是能一眼看出来的错误，因此这里把三种来法（新建、接续、分叉）都
 * 钉在真正的 JSONL 仓库上：断言落到「哪个文件里多了什么」。
 */

const home = mkdtempSync(join(tmpdir(), "reins-home-"));
const workRoot = mkdtempSync(join(tmpdir(), "reins-target-"));
// 会话目录由配置目录推出，必须把它指到临时目录：否则测试会写进使用者的真实会话目录
process.env["REINS_HOME"] = home;
const store = new JsonlSessionStore();

after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(workRoot, { recursive: true, force: true });
});

/** 在会话目录里造一个既有会话，返回它的标识。 */
async function seed(id: string, turns: readonly string[]): Promise<string> {
	const dir = sessionsDir(workRoot);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.jsonl`);
	const session = new Session({ id, cwd: workRoot, file, writer: store.create({ id, cwd: workRoot, file }) });
	for (const turn of turns) {
		await session.append({ type: "message", message: { role: "user", content: turn } });
	}
	await session.close();
	return id;
}

function options(overrides: Partial<CliOptions>): CliOptions {
	return { ...parseArgs([]), ...overrides };
}

describe("挑选会话", () => {
	it("没有给出接续选项时新建一个", () => {
		const session = openSession(options({ command: "chat" }), { workRoot, store });
		assert.equal(session.entries().length, 0);
		assert.ok(session.path?.includes("sessions"));
	});

	it("没有会话仓库时新建仍可用，只是不留文件", () => {
		const session = openSession(options({ command: "chat" }), { workRoot, store: undefined });
		assert.equal(session.path, null);
	});

	it("--continue 接的是最近更新过的那个会话", async () => {
		await seed("older", ["早一点的会话"]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const newest = await seed("newer", ["晚一点的会话"]);

		const session = openSession(options({ command: "chat", continueSession: true }), { workRoot, store });
		assert.equal(session.id, newest);
		assert.equal(session.entries().length, 1);
	});

	it("--resume 按标识接续，前缀唯一时也认", async () => {
		const id = await seed("resume-target", ["甲", "乙"]);
		const exact = openSession(options({ command: "chat", resume: id }), { workRoot, store });
		assert.equal(exact.id, id);
		assert.equal(exact.entries().length, 2);

		const byPrefix = openSession(options({ command: "chat", resume: id.slice(0, 5) }), { workRoot, store });
		assert.equal(byPrefix.id, id);
	});

	it("找不到会话或标识有歧义时明确报错", () => {
		assert.throws(
			() => openSession(options({ command: "chat", resume: "不存在的标识" }), { workRoot, store }),
			/没有找到会话/,
		);
		const listings = [
			{ id: "abc111", file: "a", updatedAt: "2026-01-01T00:00:00.000Z", entryCount: 1, title: undefined, forkedFrom: undefined },
			{ id: "abc222", file: "b", updatedAt: "2026-01-01T00:00:00.000Z", entryCount: 1, title: undefined, forkedFrom: undefined },
		];
		assert.throws(() => resolveListing(listings, "abc"), /不唯一/);
	});

	it("没有会话仓库时接续与分叉都明确报错", () => {
		assert.throws(
			() => openSession(options({ command: "chat", continueSession: true }), { workRoot, store: undefined }),
			/会话存储没有装载/,
		);
	});

	it("--fork 在分叉点为止复制出一份，原会话不动", async () => {
		const id = await seed("fork-source", ["甲", "乙"]);
		const source = openSession(options({ command: "chat", resume: id }), { workRoot, store });
		const second = source.entries()[1].id;

		const forked = openSession(
			options({ command: "chat", resume: id, fork: true, forkAt: source.entries()[0].id }),
			{ workRoot, store },
		);
		assert.notEqual(forked.id, id);
		assert.notEqual(forked.path, source.path);
		assert.equal(forked.entries().length, 1);
		assert.equal(store.read(forked.path as string).header?.forkedFrom?.entry, source.entries()[0].id);

		await forked.append({ type: "message", message: { role: "user", content: "岔开的一条" } });
		await forked.close();

		// 原会话的条目数与叶子都没变
		const original = store.read(source.path as string);
		assert.equal(original.entries.length, 2);
		assert.equal(original.entries[1].id, second);
	});

	it("接续之后能接着原来的话题继续", async () => {
		const id = await seed("continue-topic", ["先读一下 a.ts"]);
		const session = openSession(options({ command: "chat", resume: id }), { workRoot, store });
		await session.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "读完了" }] } });
		await session.close();

		// 再开一次，上下文里是完整的两条
		const reopened = openSession(options({ command: "chat", resume: id }), { workRoot, store });
		assert.equal(reopened.state().messages.length, 2);
		assert.equal(reopened.leafId, reopened.entries()[1].id);
	});
});
