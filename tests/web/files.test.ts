import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { MAX_FILE_BYTES, fileTree, readWorkspaceFile, searchWorkspaceFiles } from "#src/web/files.ts";
import { WorkspaceBoundary } from "#src/workspace/boundary.ts";

/** 只读文件接口：目录层、忽略规则、二进制与截断。 */

const roots: string[] = [];

async function workspace(): Promise<WorkspaceBoundary> {
	const root = await mkdtemp(join(tmpdir(), "reins-files-"));
	roots.push(root);
	return new WorkspaceBoundary(root);
}

after(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("文件树", () => {
	it("目录在前，按 .gitignore 过滤", async () => {
		const ws = await workspace();
		await mkdir(join(ws.root, "src"));
		await mkdir(join(ws.root, "build"));
		await writeFile(join(ws.root, ".gitignore"), "ignored.txt\nbuild/\n");
		await writeFile(join(ws.root, "ignored.txt"), "x");
		await writeFile(join(ws.root, "build", "out.js"), "x");
		await writeFile(join(ws.root, "README.md"), "# hi");
		await writeFile(join(ws.root, "src", "a.ts"), "export const a = 1;");

		const tree = fileTree(ws, "");
		assert.deepEqual(
			tree.entries.map((entry) => entry.path),
			["src", ".gitignore", "README.md"],
		);
		assert.equal(fileTree(ws, "src").entries[0]?.path, "src/a.ts");
	});

	it("工作区外的路径直接拒绝", async () => {
		const ws = await workspace();
		assert.throws(() => fileTree(ws, ".."), /outside the workspace/);
		assert.throws(() => readWorkspaceFile(ws, "../secret.txt"), /outside the workspace/);
	});
});

describe("文件读取", () => {
	it("文本按 UTF-8 解码，二进制只回报类型", async () => {
		const ws = await workspace();
		await writeFile(join(ws.root, "a.txt"), "第一行\n第二行");
		await writeFile(join(ws.root, "bin.dat"), Buffer.from([0, 1, 2, 3]));

		const text = readWorkspaceFile(ws, "a.txt");
		assert.equal(text.text, "第一行\n第二行");
		assert.equal(text.binary, false);
		assert.equal(text.truncated, false);

		const binary = readWorkspaceFile(ws, "bin.dat");
		assert.equal(binary.binary, true);
		assert.equal(binary.text, "");
	});

	it("超过上限时截断并标注", async () => {
		const ws = await workspace();
		await writeFile(join(ws.root, "big.txt"), Buffer.alloc(MAX_FILE_BYTES + 16, 0x61));
		const file = readWorkspaceFile(ws, "big.txt");
		assert.equal(file.truncated, true);
		assert.equal(file.text.length, MAX_FILE_BYTES);
	});
});

describe("文件搜索", () => {
	it("按路径子串匹配并遵守上限", async () => {
		const ws = await workspace();
		await mkdir(join(ws.root, "src"));
		await writeFile(join(ws.root, "src", "alpha.ts"), "a");
		await writeFile(join(ws.root, "src", "beta.ts"), "b");

		const hits = searchWorkspaceFiles(ws, "alpha", 10);
		assert.deepEqual(hits, [{ path: "src/alpha.ts", kind: "file" }]);
		assert.equal(searchWorkspaceFiles(ws, ".ts", 1).length, 1);
		assert.deepEqual(searchWorkspaceFiles(ws, "  ", 10), []);
	});
});
