import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { grepTool } from "../../../src/tools/builtin/grep.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";

async function grep(root: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
	const result = await grepTool.execute({
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

/** 每个用例自己建目录，结束后删掉。 */
async function withTree(files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "reins-grep-"));
	try {
		for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
		await body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("按内容检索", () => {
	it("命中行按 路径:行号: 内容 返回", async () => {
		await withTree({ "a.ts": "first\nconst needle = 1;\n" }, async (root) => {
			const result = await grep(root, { pattern: "needle" });
			assert.equal(result.isError, false);
			assert.match(result.content, /a\.ts:2: const needle = 1;/);
		});
	});

	it("literal 为真时按纯文本匹配，正则元字符不生效", async () => {
		await withTree({ "a.txt": "a.b\naxb\n" }, async (root) => {
			const result = await grep(root, { pattern: "a.b", literal: true });
			assert.match(result.content, /a\.txt:1: a\.b/);
			assert.doesNotMatch(result.content, /a\.txt:2:/);
		});
	});

	it("超过大小上限的文件不参与检索", async () => {
		// 上限是 2 MB：再大的多半是生成物或数据，读进来只是白花内存
		const big = `${"x".repeat(3 * 1024 * 1024)}\nneedle\n`;
		await withTree({ "big.log": big, "small.txt": "needle\n" }, async (root) => {
			const result = await grep(root, { pattern: "needle" });
			assert.match(result.content, /small\.txt:1: needle/);
			assert.doesNotMatch(result.content, /big\.log/);
		});
	});

	it("没有命中时说清楚检查了多少个文件", async () => {
		await withTree({ "a.txt": "nothing here\n" }, async (root) => {
			const result = await grep(root, { pattern: "absent" });
			assert.match(result.content, /No matches for "absent"/);
		});
	});

	it("正则写错时直接报错，不静默返回空结果", async () => {
		await withTree({ "a.txt": "x\n" }, async (root) => {
			const result = await grep(root, { pattern: "(" });
			assert.equal(result.isError, true);
			assert.match(result.content, /not a valid regular expression/);
		});
	});
});
