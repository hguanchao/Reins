import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	detectAtContext,
	indexWorkspaceFiles,
	matchFiles,
	type FileEntry,
} from "../../../src/plugins/tui-plugin/file-search.ts";

const tempDirs: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "reins-files-"));
	tempDirs.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "src", "app.ts"), "app");
	writeFileSync(join(root, "src", "util.ts"), "util");
	writeFileSync(join(root, "docs", "guide.md"), "guide");
	writeFileSync(join(root, "README.md"), "readme");
	writeFileSync(join(root, ".env"), "secret");
	writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
	writeFileSync(join(root, ".git", "config"), "");
	return root;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("@ 上下文", () => {
	it("识别光标所在的 @ 词，包含目录与隐藏模式", () => {
		assert.deepEqual(detectAtContext("@sr", 3), { start: 0, end: 3, query: "sr", hidden: false });
		assert.deepEqual(detectAtContext("open @src/ap", 12), {
			start: 5,
			end: 12,
			query: "src/ap",
			hidden: false,
		});
		assert.equal(detectAtContext("@!env", 5)?.hidden, true);
		assert.equal(detectAtContext("@src,", 4)?.end, 4, "comma ends the token");
	});

	it("邮箱形态与词尾之后不触发", () => {
		assert.equal(detectAtContext("user@example.com", 16), undefined);
		assert.equal(detectAtContext("test_@foo", 9), undefined);
		assert.equal(detectAtContext("@src file", 9), undefined);
	});
});

describe("文件匹配", () => {
	const files: readonly FileEntry[] = [
		{ path: "src/app.ts", kind: "file" },
		{ path: "src/util.ts", kind: "file" },
		{ path: "docs/guide.md", kind: "file" },
		{ path: "src", kind: "directory" },
		{ path: ".env", kind: "file" },
	];

	it("空查询先列目录，再按路径排序", () => {
		assert.deepEqual(
			matchFiles(files, "").map((entry) => entry.path),
			["src", "src/app.ts", "src/util.ts", "docs/guide.md"],
		);
	});

	it("文件名前缀优先于路径前缀与子序列", () => {
		assert.deepEqual(matchFiles(files, "app").map((entry) => entry.path), ["src/app.ts"]);
		assert.deepEqual(matchFiles(files, "src").map((entry) => entry.path), [
			"src",
			"src/app.ts",
			"src/util.ts",
		]);
	});

	it("隐藏文件只在 ! 模式下出现", () => {
		assert.ok(!matchFiles(files, "env").some((entry) => entry.path === ".env"));
		assert.deepEqual(matchFiles(files, "!env").map((entry) => entry.path), [".env"]);
	});

	it("尾斜杠把结果限定在该目录下", () => {
		assert.deepEqual(
			matchFiles(files, "src/").map((entry) => entry.path),
			["src/app.ts", "src/util.ts"],
		);
	});
});

describe("工作区索引", () => {
	it("跳过 .git 与 node_modules，保留其他点文件", async () => {
		const root = workspace();
		const entries = await indexWorkspaceFiles(root);
		const paths = entries.map((entry) => entry.path);
		assert.ok(paths.includes("src/app.ts"));
		assert.ok(paths.includes("docs/guide.md"));
		assert.ok(paths.includes(".env"));
		assert.ok(!paths.some((path) => path.startsWith(".git/")));
		assert.ok(!paths.some((path) => path.startsWith("node_modules/")));
		assert.equal(entries.find((entry) => entry.path === "src")?.kind, "directory");
	});

	it("达到上限就停止", async () => {
		const root = workspace();
		const entries = await indexWorkspaceFiles(root, { maxEntries: 2 });
		assert.equal(entries.length, 2);
	});
});
