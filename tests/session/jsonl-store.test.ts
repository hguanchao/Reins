import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { JsonlSessionStore, parseSessionText } from "../../src/session/jsonl-store.ts";
import { SESSION_VERSION, type SessionEntry, type SessionHeaderEntry } from "../../src/session/port.ts";
import type { SessionWriter } from "../../src/session/store.ts";

const T = "2026-01-01T00:00:00Z";

/** 每个用例各自一个临时目录，免去共享状态。 */
function workdir(name: string): string {
	const suffix = Math.random().toString(16).slice(2);
	const directory = join(tmpdir(), `reins-jsonl-${name}-${suffix}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

function entry(id: string, content: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: T, message: { role: "user", content } };
}

describe("JSONL 会话文件", () => {
	it("create 写首行,write 追加,read 读回来", () => {
		const dir = workdir("create");
		const store = new JsonlSessionStore();
		const file = join(dir, "s1.jsonl");
		const writer = store.create({ id: "s1", cwd: dir, file, forkedFrom: undefined });
		writer.write(entry("a", "hello"));
		writer.write(entry("b", "world"));
		writer.end();
		assert.ok(existsSync(file));

		const read = store.read(file);
		assert.equal(read.header?.id, "s1");
		assert.equal(read.header?.version, SESSION_VERSION);
		assert.deepEqual(
			read.entries.map((item) => (item.type === "message" ? item.message.content : item.type)),
			["hello", "world"],
		);
	});

	it("不写就别落文件，end 只放锁", () => {
		const dir = workdir("no-write");
		const file = join(dir, "never.jsonl");
		const writer = new JsonlSessionStore().create({ id: "x", cwd: dir, file });
		writer.end();
		assert.equal(existsSync(file), false);
	});

	it("begin 只写头部，空会话也能接续", () => {
		const dir = workdir("begin");
		const file = join(dir, "empty.jsonl");
		const store = new JsonlSessionStore();
		const writer = store.create({ id: "empty", cwd: dir, file });
		writer.begin();
		writer.end();

		const read = store.read(file);
		assert.equal(read.header?.id, "empty");
		assert.deepEqual(read.entries, []);

		const appended = store.append(file);
		appended.write(entry("a", "later"));
		appended.end();
		assert.equal(store.read(file).entries.length, 1);
	});

	it("append 接续既有文件", () => {
		const dir = workdir("append");
		const file = join(dir, "s.jsonl");
		const store = new JsonlSessionStore();
		const first = store.create({ id: "s", cwd: dir, file });
		first.write(entry("a", "one"));
		first.end();

		const writer: SessionWriter = store.append(file);
		writer.write(entry("b", "later"));
		writer.end();

		const again = store.read(file);
		assert.equal(again.entries.length, 2);
		assert.equal((again.entries[1] as { message: { content: string } }).message.content, "later");
	});

	it("丢失头部的文件能读也能接续", () => {
		const dir = workdir("no-header");
		const file = join(dir, "broken.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: T, message: { role: "user", content: "x" } })}\n`, "utf8");
		const store = new JsonlSessionStore();
		// read(): 无头但有条目、没有坏行，读得动
		assert.equal(store.read(file).entries.length, 1);

		const writer = store.append(file);
		writer.write(entry("b", "y"));
		writer.end();
		assert.equal(store.read(file).entries.length, 2);
	});

	it("目标文件已存在时 create 的写入报错而不覆盖", () => {
		const dir = workdir("dup");
		const file = join(dir, "dup.jsonl");
		const store = new JsonlSessionStore();
		const first = store.create({ id: "s", cwd: dir, file });
		first.write(entry("a", "x"));
		first.end();

		// 写要落到磁盘才知道撞名；构造时不写
		const second = store.create({ id: "s", cwd: dir, file });
		assert.throws(() => second.write(entry("a", "y")), /Cannot write the session file/);
		second.end();
		// 原文件内容没有被破坏
		assert.equal(store.read(file).entries.length, 1);
	});

	it("第一次写失败后面再写也报错,放锁后不再拦", () => {
		const dir = workdir("fail");
		const store = new JsonlSessionStore();
		// 目录用一个不可写文件占住名字，让写进程必然失败
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "", "utf8");
		const file = join(blocked, "sub.jsonl"); // blocked 是文件，不能有子路径
		const writer = store.create({ id: "x", cwd: dir, file });
		assert.throws(() => writer.write(entry("a", "x")));
		assert.throws(() => writer.write(entry("b", "x")), /already failed to write/);
		writer.end();
	});

	it("list 按更新时间倒序,标题取第一条用户消息的前 60 字", () => {
		const dir = workdir("list");
		const store = new JsonlSessionStore();
		const a = join(dir, "a.jsonl");
		const writer = store.create({ id: "a", cwd: dir, file: a });
		writer.write(entry("a", "hello"));
		writer.end();

		const listing = store.list(dir);
		assert.equal(listing.length, 1);
		assert.equal(listing[0]!.id, "a");
		assert.equal(listing[0]!.title, "hello");
		assert.equal(typeof listing[0]!.updatedAt, "string");
	});

	it("list 的标题取当前分支的第一条用户消息", () => {
		const dir = workdir("branch-title");
		const file = join(dir, "branch.jsonl");
		const store = new JsonlSessionStore();
		const writer = store.create({ id: "b", cwd: dir, file });
		writer.write(entry("m1", "old topic"));
		writer.write({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: T,
			message: { role: "user", content: "old follow-up" },
		});
		// 回到空会话后重新开始：文件里第一条用户消息仍属于旧分支
		writer.write({ type: "branch", id: "br", parentId: null, timestamp: T, reason: "rewind" });
		writer.write({
			type: "message",
			id: "m3",
			parentId: "br",
			timestamp: T,
			message: { role: "user", content: "new topic" },
		});
		writer.end();

		const listing = store.list(dir);
		assert.equal(listing[0]!.title, "new topic");
		assert.equal(listing[0]!.entryCount, 4);
	});

	it("不存在的目录 list 返回空", () => {
		const dir = workdir("absent");
		assert.deepEqual(new JsonlSessionStore().list(join(dir, "nothing-here")), []);
	});

	it("标题超长截到 60 字符", () => {
		const dir = workdir("title");
		const file = join(dir, "long.jsonl");
		const store = new JsonlSessionStore();
		const writer = store.create({ id: "long", cwd: dir, file });
		writer.write(entry("a", "t".repeat(200)));
		writer.end();

		const listing = store.list(dir);
		assert.equal(listing[0]!.title?.length, 61); // 60 字符 + 省略号
		assert.ok(listing[0]!.title?.endsWith("…"));
	});

	it("list 对坏文件不挑坏行,标题缺失时不给标题", () => {
		const dir = workdir("badfile");
		const file = join(dir, "no-user.jsonl");
		const store = new JsonlSessionStore();
		const writer = store.create({ id: "n", cwd: dir, file });
		writer.write({
			type: "message",
			id: "a",
			parentId: null,
			timestamp: T,
			message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
		});
		writer.end();

		const listing = store.list(dir);
		assert.equal(listing[0]!.title, undefined);
		assert.equal(listing[0]!.entryCount, 1);
	});
});

describe("会话文本解析", () => {
	it("首行会话头与条目树", () => {
		const header: SessionHeaderEntry = {
			type: "session",
			version: SESSION_VERSION,
			id: "id1",
			timestamp: T,
			cwd: "C:\\w",
		};
		const text = `${JSON.stringify(header)}\n${JSON.stringify(entry("a", "one"))}\n\n`;
		const parsed = parseSessionText(text);
		assert.equal(parsed.header?.id, "id1");
		assert.equal(parsed.entries.length, 1);
		assert.equal(parsed.skippedLines, 0);
	});

	it("坏行计数", () => {
		// not json 解析不了；{} 缺 type 不认账——两行都跳过
		const parsed = parseSessionText("not json\n{}\n");
		assert.equal(parsed.entries.length, 0);
		assert.equal(parsed.skippedLines, 2);
	});

	it("不认识的条目类型跳过而不硬读", () => {
		const parsed = parseSessionText(`${JSON.stringify({ type: "future_thing", id: "z" })}\n`);
		assert.equal(parsed.entries.length, 0);
		assert.equal(parsed.skippedLines, 1);
	});

	it("空文件没有头", () => {
		const parsed = parseSessionText("");
		assert.equal(parsed.header, undefined);
		assert.equal(parsed.entries.length, 0);
	});
});

describe("会话条目的字段校验", () => {
	it("消息条目缺关键字段时拒收,不带着坏形状进回放", () => {
		const bad = [
			{ type: "message", message: { role: "toolResult", toolCallId: "1" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: "not an object" },
			{ type: "message" },
		];
		const parsed = parseSessionText(bad.map((entry) => JSON.stringify(entry)).join("\n"));
		assert.equal(parsed.entries.length, 0);
		assert.equal(parsed.skippedLines, 4);
	});

	it("其余条目类型校验各自的关键字段", () => {
		const bad = [
			{ type: "system" },
			{ type: "model_change" },
			{ type: "effort_change", effort: 3 },
			{ type: "usage", model: "m" },
			{ type: "compaction", summary: "s" },
		];
		const parsed = parseSessionText(bad.map((entry) => JSON.stringify(entry)).join("\n"));
		assert.equal(parsed.entries.length, 0);
		assert.equal(parsed.skippedLines, 5);
	});

	it("分支标记按 reason 校验", () => {
		const good = { type: "branch", id: "b", parentId: "a", timestamp: T, reason: "switch" };
		const parsed = parseSessionText(`${JSON.stringify(good)}\n`);
		assert.equal(parsed.entries.length, 1);
		assert.equal(parsed.skippedLines, 0);

		const bad = parseSessionText(`${JSON.stringify({ ...good, reason: "other" })}\n`);
		assert.equal(bad.entries.length, 0);
		assert.equal(bad.skippedLines, 1);
	});

	it("会话头缺 id 或版本号按坏行拒收", () => {
		const parsed = parseSessionText(
			`${JSON.stringify({ type: "session", cwd: "/w" })}\n${JSON.stringify({ type: "session", id: "s", version: 1, cwd: "/w" })}\n`,
		);
		assert.equal(parsed.header?.id, "s");
		assert.equal(parsed.skippedLines, 1);
	});

	it("形状完好的条目照常读入", () => {
		const good = [
			{ type: "message", id: "a", message: { role: "user", content: "hi" } },
			{ type: "message", id: "b", message: { role: "toolResult", toolCallId: "1", toolName: "read", content: "x", isError: false } },
			{ type: "usage", id: "c", provider: "p", model: "m", kind: "turn", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cost: undefined },
		];
		const parsed = parseSessionText(good.map((entry) => JSON.stringify(entry)).join("\n"));
		assert.equal(parsed.entries.length, 3);
		assert.equal(parsed.skippedLines, 0);
	});
});
