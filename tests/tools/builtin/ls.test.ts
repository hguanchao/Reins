import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { lsTool } from "#src/tools/builtin/ls.ts";
import { WorkspaceBoundary } from "#src/workspace/boundary.ts";

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

describe("列出一层目录", () => {
	it("只列一层，目录在前，按 .gitignore 过滤", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-ls-"));
		try {
			mkdirSync(join(root, "output"), { recursive: true });
			mkdirSync(join(root, "server", "__pycache__"), { recursive: true });
			mkdirSync(join(root, ".git"), { recursive: true });
			mkdirSync(join(root, "node_modules"), { recursive: true });
			mkdirSync(join(root, ".venv", "lib"), { recursive: true });
			writeFileSync(join(root, ".gitignore"), "node_modules\n.venv\n__pycache__\n");
			writeFileSync(join(root, "docker-compose.yml"), "");
			writeFileSync(join(root, "Dockerfile"), "");
			writeFileSync(join(root, "README.md"), "");
			writeFileSync(join(root, "output", "a.txt"), "");
			writeFileSync(join(root, "output", "b.csv"), "");
			writeFileSync(join(root, "server", "__init__.py"), "");
			writeFileSync(join(root, "server", "__pycache__", "x.pyc"), "");
			writeFileSync(join(root, ".git", "hidden"), "");
			writeFileSync(join(root, "node_modules", "skip.js"), "");
			writeFileSync(join(root, ".venv", "lib", "site.py"), "");

			const result = await lsTool.execute({ ...context(root), args: { path: "." } });
			const content = result.content;

			assert.ok(content.startsWith("./\n"));
			assert.ok(content.includes("output/"));
			assert.ok(content.includes("server/"));
			assert.ok(content.includes("docker-compose.yml"));
			assert.ok(content.includes("Dockerfile"));
			assert.ok(content.includes("README.md"));
			assert.ok(content.includes(".gitignore"));
			// 目录排在文件之前
			assert.ok(content.indexOf("output/") < content.indexOf("Dockerfile"));
			// 只列一层：子项不出现
			assert.equal(content.includes("a.txt"), false);
			assert.equal(content.includes("__init__.py"), false);
			// 版本库目录与 .gitignore 命中的目录不列
			assert.equal(content.includes(".git/"), false);
			assert.equal(content.includes("node_modules"), false);
			assert.equal(content.includes(".venv"), false);
			assert.deepEqual(result.details, { path: ".", total: 6, shown: 6, truncated: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("超过 limit 时截断并提示", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-ls-limit-"));
		try {
			for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `f${index}.txt`), "");

			const result = await lsTool.execute({ ...context(root), args: { limit: 2 } });

			assert.equal((result.details as { shown: number }).shown, 2);
			assert.equal((result.details as { truncated: boolean }).truncated, true);
			assert.ok(result.content.includes("listing stopped"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("空目录给出明确标记", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-ls-empty-"));
		try {
			mkdirSync(join(root, "empty"));

			const result = await lsTool.execute({ ...context(root), args: { path: "empty" } });

			assert.equal(result.content, "empty/\n(empty)");
			assert.deepEqual(result.details, { path: "empty", total: 0, shown: 0, truncated: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("文件路径明确报错", async () => {
		const root = mkdtempSync(join(tmpdir(), "reins-ls-file-"));
		try {
			writeFileSync(join(root, "a.txt"), "");

			const result = await lsTool.execute({ ...context(root), args: { path: "a.txt" } });

			assert.equal(result.isError, true);
			assert.match(result.content, /is not a directory/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
