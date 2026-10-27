import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { findTool } from "../../../src/tools/builtin/find.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";

describe("查找文件", () => {
	it("返回相对工作根的路径，而不是相对搜索起点", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-find-"));
		try {
			mkdirSync(join(root, "src", "nested"), { recursive: true });
			mkdirSync(join(root, "other"));
			writeFileSync(join(root, "src", "a.ts"), "x");
			writeFileSync(join(root, "src", "nested", "b.ts"), "x");
			writeFileSync(join(root, "other", "c.ts"), "x");

			const result = await findTool.execute({
				callId: "1",
				args: { pattern: "**/*.ts", path: "src" },
				signal: new AbortController().signal,
				onUpdate: () => {},
				workspace: new WorkspaceBoundary(root),
				sandbox: { assertPathAllowed: () => {} } as never,
				session: { id: "s", path: null } as never,
			});

			const lines = result.content.split("\n");
			assert.ok(lines.includes("src/a.ts"));
			assert.ok(lines.includes("src/nested/b.ts"));
			assert.equal(lines.includes("a.ts"), false);
			assert.equal(result.content.includes("other/c.ts"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
