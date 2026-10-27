import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { SessionLock } from "../../src/session/lock.ts";

describe("会话写者锁", () => {
	const DIR = join(tmpdir(), `reins-lock-${Date.now()}`);
	const FILE = join(DIR, "s.jsonl");
	afterEach(() => rmSync(DIR, { recursive: true, force: true }));

	it("取锁成功后锁文件里带着持有者信息", () => {
		mkdirSync(DIR, { recursive: true });
		const lock = SessionLock.acquire(FILE);
		assert.ok(existsSync(`${FILE}.lock`));
		const holder = readFileSync(`${FILE}.lock`, "utf8");
		assert.ok(holder.startsWith(String(process.pid)));
		lock.release();
	});

	it("第二个进程拿不到锁,错误里说明持锁者", () => {
		mkdirSync(DIR, { recursive: true });
		const first = SessionLock.acquire(FILE);
		assert.throws(() => SessionLock.acquire(FILE), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Session file is locked/);
			assert.match(error.message, /\.lock \(held by /);
			return true;
		});
		first.release();
	});

	it("释放后可再取", () => {
		mkdirSync(DIR, { recursive: true });
		const first = SessionLock.acquire(FILE);
		first.release();
		const second = SessionLock.acquire(FILE);
		second.release();
	});

	it("双重释放不出错", () => {
		mkdirSync(DIR, { recursive: true });
		const lock = SessionLock.acquire(FILE);
		lock.release();
		lock.release();
		assert.equal(existsSync(`${FILE}.lock`), false);
	});
});
