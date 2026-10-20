import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writeTool } from "../../../src/tools/builtin/write.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";

function context(root: string) {
	return {
		callId: "1",
		signal: new AbortController().signal,
		onUpdate: () => {},
		workspace: new WorkspaceBoundary(root),
		sandbox: { assertPathAllowed: () => {} } as never,
		session: { id: "s", path: null } as never,
	};
}

describe("写入文件", () => {
	it("新建文件时详情里带全为新增的 diff", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-write-"));
		try {
			const result = await writeTool.execute({
				...context(root),
				args: { path: "a.ts", content: "hello\nworld" },
			});
			const details = result.details as { created: boolean; diff: string };

			assert.equal(details.created, true);
			assert.ok(details.diff.includes("+ hello"));
			assert.ok(details.diff.includes("+ world"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("覆盖文件时详情里带删除与新增行", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-write-diff-"));
		try {
			await writeTool.execute({ ...context(root), args: { path: "a.ts", content: "old\nvalue" } });
			const result = await writeTool.execute({
				...context(root),
				args: { path: "a.ts", content: "new\nvalue" },
			});
			const details = result.details as { created: boolean; diff: string };

			assert.equal(details.created, false);
			assert.ok(details.diff.includes("- old"));
			assert.ok(details.diff.includes("+ new"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
