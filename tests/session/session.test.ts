import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Session } from "../../src/session/session.ts";
import { JsonlSessionStore } from "../../src/plugins/session-plugin/jsonl-store.ts";
import type { SessionEntry, SessionHeaderEntry } from "../../src/session/port.ts";
import type { SessionStore, SessionWriter } from "../../src/session/store.ts";
import { SESSION_VERSION } from "../../src/session/port.ts";

const T = "2026-01-01T00:00:00Z";

const DIR = join(tmpdir(), `reins-session-${Date.now()}`);

function memoryStore(): SessionStore & { files: Map<string, string> } {
	const files = new Map<string, string>();
	const fake = {
		create(options: { id: string; cwd: string; file: string; forkedFrom?: { session: string; entry: string } }): SessionWriter {
			const header: SessionHeaderEntry = {
				type: "session",
				version: SESSION_VERSION,
				id: options.id,
				timestamp: T,
				cwd: options.cwd,
				forkedFrom: options.forkedFrom,
			};
			let text = `${JSON.stringify(header)}\n`;
			existsInFile(options.file, text);
			return {
				begin() {
					files.set(options.file, text);
				},
				write(entry: SessionEntry) {
					text += `${JSON.stringify(entry)}\n`;
					files.set(options.file, text);
				},
				end() {
					files.set(options.file, text);
				},
			};
			function existsInFile(target: string, initial: string): void {
				if (files.has(target)) throw new Error("already there");
				files.set(target, initial);
			}
		},
		read(file: string) {
			const text = files.get(file);
			if (text === undefined) throw new Error(`unknown file ${file}`);
			return text === "" ? { header: undefined, entries: [] } : JSON.parse(text.split("\n")[0]) as { header: SessionHeaderEntry; entries: SessionEntry[] };
		},
		append(file: string) {
			return fake.create({ id: "ignored", cwd: "", file });
		},
		list() {
			return [];
		},
	};
	return Object.assign(fake, { files });
}

function userEntry(id: string, text: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: T, message: { role: "user", content: text } };
}

describe("会话对象", () => {
	it("内存会话:追加与折叠状态", async () => {
		const session = new Session({ id: "m", cwd: "/", file: null });
		await session.append({ type: "message", message: { role: "user", content: "hi" } });
		assert.equal(session.entryCount, 1);
		assert.ok(session.leafId !== null);
		assert.deepEqual(session.state().messages, [{ role: "user", content: "hi" }]);
	});

	it("file 非 null 时必须有 writer", () => {
		assert.throws(() => new Session({ id: "x", cwd: "/", file: "a.jsonl" }), /requires a session store/);
	});

	it("关闭后再追加报错,重复关闭无事", async () => {
		const session = new Session({ id: "m", cwd: "/", file: null });
		await session.close();
		await session.close();
		await assert.rejects(
			() => session.append({ type: "message", message: { role: "user", content: "x" } }),
			/Session is closed/,
		);
		assert.throws(() => session.begin(), /Session is closed/);
	});

	it("begin 立即写头部，空会话也能接续", async () => {
		const dir = DIR + "-begin";
		mkdirSync(dir, { recursive: true });
		const store = new JsonlSessionStore();
		const file = join(dir, "empty.jsonl");
		const session = new Session({
			id: "empty",
			cwd: dir,
			file,
			writer: store.create({ id: "empty", cwd: dir, file }),
		});
		session.begin();
		await session.close();
		assert.ok(existsSync(file));

		const resumed = Session.open(file, store);
		assert.equal(resumed.id, "empty");
		assert.equal(resumed.entryCount, 0);
		await resumed.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("接续既有历史:叶子取最后一条路径的末尾,旧条目不再落盘", async () => {
		const history = [userEntry("a", "one"), userEntry("b", "two")];
		const store = memoryStore();
		const session = new Session({
			id: "r",
			cwd: "/",
			file: "h.jsonl",
			writer: store.append("h.jsonl"),
			entries: history,
		});
		assert.equal(session.leafId, "b");
		await session.append({ type: "message", message: { role: "user", content: "three" } });
		assert.equal(session.entryCount, 3);
		await session.close();
	});

	it("分叉:复制从根到分叉点的路径,头部记下出处", () => {
		const dir = DIR + "-fork";
		mkdirSync(dir, { recursive: true });
		const store = new JsonlSessionStore();

		const sourceFile = join(dir, "src.jsonl");
		const sourceWriter = store.create({ id: "src", cwd: dir, file: sourceFile });
		const source = new Session({ id: "src", cwd: dir, file: sourceFile, writer: sourceWriter });
		source.append({ type: "message", message: { role: "user", content: "first" } }).catch(() => undefined);
		source.append({ type: "message", message: { role: "user", content: "second" } }).catch(() => undefined);

		const forkFile = join(dir, "fork.jsonl");
		const fork = Session.fork(source, { id: "fk", cwd: dir, file: forkFile, store });

		// 树里有两层 → 复制两条
		assert.equal(fork.entryCount, 2, "path to leaf copies all entries");
		assert.ok(fork.cwd === dir);
		fork.close().catch(() => undefined);
		source.close().catch(() => undefined);
	});

	it("JSONL 全链路:创建、续读、再写", async () => {
		mkdirSync(DIR, { recursive: true });
		const store = new JsonlSessionStore();
		const file = join(DIR, "chain.jsonl");

		const created = store.create({ id: "chain", cwd: DIR, file });
		const first = new Session({ id: "chain", cwd: DIR, file, writer: created });
		await first.append({ type: "message", message: { role: "user", content: "opening" } });
		await first.close();
		assert.ok(existsSync(file));

		const resumed = Session.open(file, store);
		assert.equal(resumed.id, "chain");
		assert.equal(resumed.entryCount, 1);
		assert.equal(resumed.leafId, first.leafId);
		await resumed.append({ type: "message", message: { role: "user", content: "follow-up" } });
		await resumed.close();

		const final = Session.open(file, store);
		assert.equal(final.entryCount, 2);
		assert.deepEqual(final.state().messages.map((message) => ("content" in message ? message.content : "")), ["opening", "follow-up"]);
		rmSync(DIR, { recursive: true, force: true });
	});

	it("版本不匹配的文件拒绝接续", () => {
		mkdirSync(DIR + "-ver", { recursive: true });
		const store = new JsonlSessionStore();
		const file = join(DIR + "-ver", "old.jsonl");
		const writer = store.create({ id: "old", cwd: DIR + "-ver", file });
		writer.write(userEntry("a", "x"));
		writer.end();
		// 改头部版本
		const lines = readFileSync(file, "utf8").split("\n");
		const header = JSON.parse(lines[0]!) as { version: number };
		header.version = 999;
		lines[0] = JSON.stringify(header);
		writeFileSync(file, lines.join("\n"), "utf8");

		assert.throws(() => Session.open(file, store), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /does not match the current version/);
			return true;
		});
		rmSync(DIR + "-ver", { recursive: true, force: true });
	});
});
