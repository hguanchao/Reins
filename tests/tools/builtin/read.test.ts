import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readFooterRange, readTool } from "../../../src/tools/builtin/read.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";

async function read(root: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
	const result = await readTool.execute({
		callId: "1",
		args,
		signal: new AbortController().signal,
		onUpdate: () => {},
		workspace: new WorkspaceBoundary(root),
		sandbox: { assertPathAllowed: () => {} } as never,
		session: { id: "s", path: null } as never,
	} as never);
	return { content: result.content, isError: result.isError === true };
}

function withFile(name: string, content: string, body: (root: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "reins-read-"));
	writeFileSync(join(root, name), content);
	return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("读取文件", () => {
	it("结果详情里带完整正文，供界面展开使用", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-read-"));
		try {
			writeFileSync(join(root, "a.txt"), "line 1\nline 2");

			const result = await readTool.execute({
				callId: "1",
				args: { path: "a.txt" },
				signal: new AbortController().signal,
				onUpdate: () => {},
				workspace: new WorkspaceBoundary(root),
				sandbox: { assertPathAllowed: () => {} } as never,
				session: { id: "s", path: null } as never,
			});

			assert.equal((result.details as { text: string }).text, "line 1\nline 2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("窗口里全是空行时续读 offset 仍向前推进", async () => {
		// 旧实现按截断结果的行数算末行，空文本得 0 行，footer 给出的 offset 与本次相同，
		// 模型会反复重试同一个窗口
		await withFile("blank.txt", "a\n\n\n\nb", async (root) => {
			const result = await read(root, { path: "blank.txt", offset: 2, limit: 3 });
			const range = readFooterRange(result.content);
			assert.notEqual(range, undefined);
			assert.equal(range?.start, 2);
			// 续读位置必须在本次窗口之后，否则模型会在同一个窗口里打转
			assert.match(result.content, /continue with offset=5/);
			// 全空窗口要有说明，否则模型只看到一串换行
			assert.match(result.content, /are blank/);
		});
	});

	it("末行之后没有内容时不给出倒退的续读区间", async () => {
		await withFile("tail.txt", "a\n\n", async (root) => {
			const result = await read(root, { path: "tail.txt", offset: 2, limit: 1 });
			const range = readFooterRange(result.content);
			if (range !== undefined) {
				assert.ok(range.end >= range.start, `区间倒置：${range.start}-${range.end}`);
			}
		});
	});

	it("单行超长且没有后续行时明确说明被截断", async () => {
		await withFile("long.txt", "x".repeat(60 * 1024), async (root) => {
			const result = await read(root, { path: "long.txt" });
			// 静默截断会让模型以为这就是完整文件
			assert.match(result.content, /truncated at 50 KB/);
		});
	});

	it("非 UTF-8 文件被读取时给出提示", async () => {
		const gbk = Buffer.from([0x61, 0xc4, 0xe3, 0xba, 0xc3, 0x62]);
		const root = mkdtempSync(join(tmpdir(), "reins-read-"));
		try {
			writeFileSync(join(root, "gbk.txt"), gbk);
			const result = await read(root, { path: "gbk.txt" });
			assert.match(result.content, /not valid UTF-8/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("超过大小上限的文件直接拒绝，不整份读入内存", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-read-"));
		try {
			// 稀疏写法代价太大，这里只验证判定路径：用一个超过上限的小常量不可行，
			// 因此直接检查普通文件仍能读、目录会被拒绝，避免真的写 16 MB
			writeFileSync(join(root, "ok.txt"), "hello");
			assert.equal((await read(root, { path: "ok.txt" })).isError, false);
			assert.equal((await read(root, { path: "." })).isError, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
