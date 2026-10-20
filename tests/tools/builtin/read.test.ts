import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readTool } from "../../../src/tools/builtin/read.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";

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
});
