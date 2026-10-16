import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { JsonlSessionStore, parseSessionText } from "../../../src/plugins/session-plugin/jsonl-store.ts";
import { Session } from "../../../src/session/session.ts";
import { SESSION_VERSION, type SessionEntry } from "../../../src/session/port.ts";

/**
 * JSONL 会话存储。
 *
 * 这里只管「条目怎么落到磁盘上」：首行是头、每条一行、文件在第一次写入时才出现、同一份文件
 * 只有一个写入者。折叠与叶子由宿主的会话模块负责，另有测试。
 */

const root = mkdtempSync(join(tmpdir(), "reins-session-store-"));
const store = new JsonlSessionStore();

after(() => {
	rmSync(root, { recursive: true, force: true });
});

function fileOf(name: string): string {
	return join(root, `${name}.jsonl`);
}

describe("JSONL 会话存储", () => {
	it("首行是会话头，之后每条一行", async () => {
		const file = fileOf("header");
		const session = new Session({
			id: "abc",
			cwd: root,
			file,
			writer: store.create({ id: "abc", cwd: root, file }),
		});
		await session.append({ type: "message", message: { role: "user", content: "甲" } });
		await session.close();

		const parsed = parseSessionText(readFileSync(file, "utf8"));
		assert.equal(parsed.skippedLines, 0);
		assert.equal(parsed.header?.type, "session");
		assert.equal(parsed.header?.version, SESSION_VERSION);
		assert.equal(parsed.header?.id, "abc");
		assert.equal(parsed.header?.cwd, root);
		assert.equal(parsed.entries.length, 1);
	});

	it("没有写入之前不建文件：只看一眼帮助不该留下空会话", async () => {
		const file = fileOf("lazy");
		const writer = store.create({ id: "lazy", cwd: root, file });
		assert.equal(existsSync(file), false);

		writer.write({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "甲" },
		});
		assert.equal(existsSync(file), true);
		writer.end();
	});

	it("文件已存在时拒绝写入，而不是接着写进去", () => {
		const file = fileOf("collision");
		writeFileSync(file, "", "utf8");

		const writer = store.create({ id: "collision", cwd: root, file });
		assert.throws(
			() => {
				writer.write({
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "甲" },
				});
			},
			/写入会话文件失败/,
		);
	});

	it("同一份文件不能被两个写入者同时写入", async () => {
		const file = fileOf("contended");
		const first = new Session({ id: "a", cwd: root, file, writer: store.create({ id: "a", cwd: root, file }) });
		await first.append({ type: "message", message: { role: "user", content: "甲" } });
		assert.ok(existsSync(`${file}.lock`));

		try {
			// 只构造不写入不留痕迹，因此冲突要到真正落笔时才暴露
			const second = new Session({ id: "b", cwd: root, file, writer: store.create({ id: "b", cwd: root, file }) });
			await assert.rejects(
				async () => second.append({ type: "message", message: { role: "user", content: "乙" } }),
				/已被占用/,
			);
		} finally {
			await first.close();
		}
		assert.ok(!existsSync(`${file}.lock`));
	});

	it("写坏一次之后不再继续写：无锁追加比停下来更危险", () => {
		const file = fileOf("broken");
		writeFileSync(file, "", "utf8");
		const writer = store.create({ id: "broken", cwd: root, file });

		const entry: SessionEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "甲" },
		};
		assert.throws(() => writer.write(entry), /写入会话文件失败/);
		assert.throws(() => writer.write(entry), /已经写入失败/);
	});

	it("只在内存里时不落盘", () => {
		const writer = store.create({ id: "memory", cwd: root, file: null });
		writer.write({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "甲" },
		});
		writer.end();
		assert.equal(existsSync(join(root, "memory.jsonl")), false);
	});

	it("解析不了的行单独计数，不当成条目", () => {
		const text = [
			JSON.stringify({ type: "session", version: 1, id: "x", timestamp: "t", cwd: "c" }),
			"{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"t\",\"message\":{\"role\":\"user\",\"content\":\"甲\"}}",
			"半截的",
		].join("\n");
		const parsed = parseSessionText(text);
		assert.equal(parsed.entries.length, 1);
		assert.equal(parsed.skippedLines, 1);
	});
});
