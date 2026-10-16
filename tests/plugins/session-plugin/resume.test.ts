import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { JsonlSessionStore } from "../../../src/plugins/session-plugin/jsonl-store.ts";
import { Session } from "../../../src/session/session.ts";

/**
 * 续聊与分叉。
 *
 * 两件事都从既有的会话开始，因此最要紧的是：接续接着原来的位置写，分叉复制出一条新路径而
 * 一个字节都不动原会话。这里用真的 JSONL 仓库，因为「条目确实落到了哪份文件里」正是要验的。
 */

const root = mkdtempSync(join(tmpdir(), "reins-session-resume-"));
const store = new JsonlSessionStore();

after(() => {
	rmSync(root, { recursive: true, force: true });
});

async function seed(name: string): Promise<{ readonly file: string; readonly session: Session }> {
	const file = join(root, `${name}.jsonl`);
	const session = new Session({
		id: name,
		cwd: root,
		file,
		writer: store.create({ id: name, cwd: root, file }),
	});
	await session.append({ type: "message", message: { role: "user", content: "第一步" } });
	await session.append({ type: "message", message: { role: "user", content: "第二步" } });
	await session.close();
	return { file, session };
}

describe("接续会话", () => {
	it("接着原来的位置继续写，旧条目一条不动", async () => {
		const { file } = await seed("resume");
		const before = readFileSync(file, "utf8");

		const session = Session.open(file, store);
		assert.equal(session.id, "resume");
		assert.equal(session.entries().length, 2);
		// 叶子是文件里最后写下的那条，追加要接在它后面
		assert.equal(session.leafId, session.entries()[1].id);

		await session.append({ type: "message", message: { role: "user", content: "第三步" } });
		await session.close();

		const after = readFileSync(file, "utf8");
		assert.ok(after.startsWith(before), "旧内容应当原样保留在前面");
		const entries = store.read(file).entries;
		assert.equal(entries.length, 3);
		assert.equal(entries[2].parentId, entries[1].id);
	});

	it("只有一条路径时叶子仍然唯一", async () => {
		const { file } = await seed("leaf");
		const session = Session.open(file, store);
		await session.close();
		assert.equal(session.entries().length, 2);
	});

	it("版本对不上时明确拒绝，而不是猜着接续", async () => {
		const { file } = await seed("wrong-version");
		// 把版本号改成将来的值：这样的文件多半有新字段，按当前格式读会读出一段错的历史
		const text = readFileSync(file, "utf8").replace('"version":1', '"version":99');
		writeFileSync(file, text, "utf8");

		assert.throws(() => Session.open(file, store), /版本 99/);
	});

	it("文件坏了就不读：宁可拒绝，也不要接出一段缺失的历史", async () => {
		const broken = join(root, "broken.jsonl");
		writeFileSync(broken, '{"type":"session","version":1,"id":"x","timestamp":"t","cwd":"c"}\n半截的\n', "utf8");
		assert.throws(() => store.read(broken), /无法解析/);
		assert.throws(() => store.append(broken), /无法解析/);
	});
});

describe("分叉会话", () => {
	it("复制到分叉点为止的路径，新会话记下出处", async () => {
		const { file } = await seed("source");
		const source = Session.open(file, store);
		const target = join(root, "branch.jsonl");

		const forked = Session.fork(source, {
			id: "branch",
			cwd: root,
			file: target,
			store,
			at: source.entries()[0].id,
		});

		// 只带上了分叉点之前的部分
		assert.equal(forked.entries().length, 1);
		assert.equal(forked.leafId, source.entries()[0].id);
		assert.equal(forked.path, target);
		await forked.close();

		const written = store.read(target);
		assert.equal(written.header?.id, "branch");
		assert.deepEqual(written.header?.forkedFrom, { session: "source", entry: source.entries()[0].id });

		// 原会话一个字节没动
		assert.equal(store.read(file).entries.length, 2);
		assert.equal(store.read(file).header?.forkedFrom, undefined);
	});

	it("不指明分叉点时从当前位置分叉", async () => {
		const { file } = await seed("source2");
		const source = Session.open(file, store);
		const target = join(root, "branch2.jsonl");

		const forked = Session.fork(source, { id: "branch2", cwd: root, file: target, store });
		assert.equal(forked.entries().length, 2);
		await forked.close();
		assert.deepEqual(store.read(target).header?.forkedFrom, {
			session: "source2",
			entry: source.entries()[1].id,
		});
	});

	it("分叉之后两个会话各写各的", async () => {
		const { file } = await seed("source3");
		const source = Session.open(file, store);
		const target = join(root, "branch3.jsonl");
		const forked = Session.fork(source, { id: "branch3", cwd: root, file: target, store });

		await source.append({ type: "message", message: { role: "user", content: "原会话继续" } });
		await forked.append({ type: "message", message: { role: "user", content: "新会话开始" } });
		await source.close();
		await forked.close();

		const original = store.read(file).entries;
		const branch = store.read(target).entries;
		assert.equal(original.length, 3);
		assert.equal(branch.length, 3);
		assert.ok(!JSON.stringify(branch).includes("原会话继续"));
		assert.ok(!JSON.stringify(original).includes("新会话开始"));
	});

	it("空会话没有什么可以分叉", () => {
		const empty = new Session({ id: "empty", cwd: root, file: null });
		assert.throws(
			() => Session.fork(empty, { id: "x", cwd: root, file: join(root, "x.jsonl"), store }),
			/还没有内容/,
		);
	});
});

describe("会话清单", () => {
	it("按更新时间从新到旧，带上标题、条目数与分叉出处", async () => {
		const { file } = await seed("list-a");
		const source = Session.open(file, store);
		const target = join(root, "list-b.jsonl");
		const forked = Session.fork(source, { id: "list-b", cwd: root, file: target, store });
		await forked.append({ type: "message", message: { role: "user", content: "分叉之后的第一句" } });
		await forked.close();
		await source.close();

		const listings = store.list(root);
		const byId = new Map(listings.map((listing) => [listing.id, listing]));

		assert.equal(byId.get("list-a")?.title, "第一步");
		assert.equal(byId.get("list-a")?.entryCount, 2);
		assert.equal(byId.get("list-b")?.entryCount, 3);
		assert.equal(byId.get("list-b")?.forkedFrom?.session, "list-a");
		assert.ok(listings[0].updatedAt >= listings[listings.length - 1].updatedAt);
	});

	it("目录不存在时是空清单，不是错误", () => {
		assert.deepEqual(store.list(join(root, "什么都没有")), []);
	});

	it("不认识的条目类型不猜着读：整个文件按坏文件处理", () => {
		const file = join(root, "unknown.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: "u", timestamp: "t", cwd: root }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: "甲" } }),
			JSON.stringify({ type: "将来才有的条目", id: "e2", parentId: "e1", timestamp: "t" }),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

		assert.throws(() => store.read(file), /无法解析/);
		// 清单仍然列得出来：它是索引，读数交给 show 与接续去严格检查
		assert.equal(store.list(root).some((listing) => listing.id === "u"), true);
	});
});
