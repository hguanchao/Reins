import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEntry } from "../../src/session/port.ts";
import { Session } from "../../src/session/session.ts";
import type { SessionWriter } from "../../src/session/store.ts";

/**
 * 会话本身。
 *
 * 不碰磁盘：这里要验证的是条目怎么串成链、状态怎么随写入更新、通道失败时内存状态会不会被
 * 改坏。落盘细节由存储插件负责，另有测试。
 */

/** 把写过的条目记下来，供断言查看。 */
class RecordingWriter implements SessionWriter {
	readonly entries: SessionEntry[] = [];
	ended = false;
	readonly #failure: string | undefined;

	constructor(failure?: string) {
		this.#failure = failure;
	}

	write(entry: SessionEntry): void {
		if (this.#failure !== undefined) throw new Error(this.#failure);
		this.entries.push(entry);
	}

	end(): void {
		this.ended = true;
	}
}

describe("会话", () => {
	it("条目串成一条链，叶子永远指最后一条", async () => {
		const writer = new RecordingWriter();
		const session = new Session({ id: "s", cwd: "/work", file: "/work/s.jsonl", writer });

		await session.append({ type: "message", message: { role: "user", content: "甲" } });
		await session.append({ type: "message", message: { role: "user", content: "乙" } });

		const entries = session.entries();
		assert.equal(entries.length, 2);
		assert.equal(entries[0].parentId, null);
		assert.equal(entries[1].parentId, entries[0].id);
		assert.equal(session.leafId, entries[1].id);
		assert.equal(writer.entries.length, 2);
	});

	it("状态随写入增量更新，与整份重放一致", async () => {
		const session = new Session({ id: "s", cwd: "/work", file: null });
		await session.append({
			type: "system",
			sections: { preamble: "开头", rules: "规则" },
			toolsAdded: [{ name: "read", description: "读", parameters: {} }],
		});
		await session.append({ type: "message", message: { role: "user", content: "甲" } });
		await session.append({ type: "effort_change", effort: "high" });

		assert.deepEqual(session.state().sections, { preamble: "开头", rules: "规则" });
		assert.deepEqual(session.state().tools.map((tool) => tool.name), ["read"]);
		assert.equal(session.state().effort, "high");
		assert.equal(session.state().messages.length, 1);
	});

	it("写入失败时状态不变，也不能拿空通道冒充成功", async () => {
		const writer = new RecordingWriter("磁盘满了");
		const session = new Session({ id: "s", cwd: "/work", file: "/work/s.jsonl", writer });

		await assert.rejects(
			async () => session.append({ type: "message", message: { role: "user", content: "甲" } }),
			/磁盘满了/,
		);
		assert.equal(session.entries().length, 0);
		assert.equal(session.state().messages.length, 0);
		assert.equal(session.leafId, null);
	});

	it("file 非 null 而没有写入通道时构造就报错", () => {
		assert.throws(() => new Session({ id: "s", cwd: "/work", file: "/work/s.jsonl" }), /需要会话存储/);
	});

	it("关闭之后不再接受条目，并交还通道", async () => {
		const writer = new RecordingWriter();
		const session = new Session({ id: "s", cwd: "/work", file: "/work/s.jsonl", writer });

		await session.close();
		assert.equal(writer.ended, true);
		await assert.rejects(
			async () => session.append({ type: "message", message: { role: "user", content: "甲" } }),
			/会话已关闭/,
		);
	});
});
