import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { SandboxView } from "../../../src/sandbox/policy.ts";
import { patchTool } from "../../../src/tools/builtin/patch.ts";
import { WorkspaceBoundary } from "../../../src/workspace/boundary.ts";

const SANDBOX: SandboxView = {
	assertPathAllowed: () => undefined,
	wrapCommand: (command) => command,
};

function workdir(name: string): string {
	const directory = join(tmpdir(), `reins-patch-${name}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

async function apply(
	root: string,
	edits: readonly { readonly path: string; readonly oldText: string; readonly newText: string }[],
) {
	return patchTool.execute({
		args: { edits },
		workspace: new WorkspaceBoundary(root),
		sandbox: SANDBOX,
	} as never);
}

describe("多文件补丁", () => {
	it("一次调用修改多个文件", async () => {
		const dir = workdir("multi");
		writeFileSync(join(dir, "a.txt"), "alpha\n", "utf8");
		writeFileSync(join(dir, "b.txt"), "beta\n", "utf8");

		const result = await apply(dir, [
			{ path: "a.txt", oldText: "alpha", newText: "one" },
			{ path: "b.txt", oldText: "beta", newText: "two" },
		]);

		assert.equal(result.isError, undefined);
		assert.match(result.content, /Updated 2 files: 2 edits applied/);
		assert.match(result.content, /### a\.txt/);
		assert.match(result.content, /### b\.txt/);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n");
		assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "two\n");
		rmSync(dir, { recursive: true, force: true });
	});

	it("任何一条编辑不合法时一个文件都不写", async () => {
		const dir = workdir("atomic");
		writeFileSync(join(dir, "a.txt"), "alpha\n", "utf8");
		writeFileSync(join(dir, "b.txt"), "beta\n", "utf8");

		const result = await apply(dir, [
			{ path: "a.txt", oldText: "alpha", newText: "one" },
			{ path: "b.txt", oldText: "missing", newText: "two" },
		]);

		assert.equal(result.isError, true);
		assert.match(result.content, /b\.txt/);
		assert.match(result.content, /was not found/);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha\n");
		assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "beta\n");
		rmSync(dir, { recursive: true, force: true });
	});

	it("同一文件的多个编辑按给出顺序合并", async () => {
		const dir = workdir("same-file");
		writeFileSync(join(dir, "a.txt"), "one two three\n", "utf8");

		const result = await apply(dir, [
			{ path: "a.txt", oldText: "one", newText: "1" },
			{ path: "a.txt", oldText: "three", newText: "3" },
		]);

		assert.equal(result.isError, undefined);
		assert.match(result.content, /Updated 1 file: 2 edits applied/);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "1 two 3\n");
		rmSync(dir, { recursive: true, force: true });
	});

	it("重叠的编辑被拒绝且不写文件", async () => {
		const dir = workdir("overlap");
		writeFileSync(join(dir, "a.txt"), "abcdef\n", "utf8");

		const result = await apply(dir, [
			{ path: "a.txt", oldText: "abc", newText: "x" },
			{ path: "a.txt", oldText: "cde", newText: "y" },
		]);

		assert.equal(result.isError, true);
		assert.match(result.content, /overlap/);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "abcdef\n");
		rmSync(dir, { recursive: true, force: true });
	});

	it("保留原有的 CRLF 行尾", async () => {
		const dir = workdir("crlf");
		writeFileSync(join(dir, "a.txt"), "alpha\r\nbeta\r\n", "utf8");

		const result = await apply(dir, [{ path: "a.txt", oldText: "alpha", newText: "one" }]);

		assert.equal(result.isError, undefined);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\r\nbeta\r\n");
		rmSync(dir, { recursive: true, force: true });
	});

	it("文件不存在时报错，不凭空创建", async () => {
		const dir = workdir("missing");
		const result = await apply(dir, [{ path: "nope.txt", oldText: "x", newText: "y" }]);
		assert.equal(result.isError, true);
		assert.match(result.content, /Failed to read nope\.txt/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("没有编辑项时拒绝", async () => {
		const dir = workdir("empty");
		const result = await apply(dir, []);
		assert.equal(result.isError, true);
		assert.match(result.content, /At least one edit/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("审批范围按文件集合生成，顺序不影响键", () => {
		const workspace = new WorkspaceBoundary(process.cwd());
		const first = patchTool.permissionScope?.(
			{
				edits: [
					{ path: "b.txt", oldText: "x", newText: "y" },
					{ path: "a.txt", oldText: "x", newText: "y" },
				],
			},
			workspace,
		);
		const second = patchTool.permissionScope?.(
			{
				edits: [
					{ path: "a.txt", oldText: "x", newText: "y" },
					{ path: "b.txt", oldText: "x", newText: "y" },
				],
			},
			workspace,
		);
		assert.ok(first !== undefined && second !== undefined);
		assert.equal(first.key, second.key);
		assert.match(first.label, /a\.txt/);
		assert.match(first.label, /b\.txt/);
	});

	it("容忍 JSON 字符串形式的 edits", () => {
		const edits = [{ path: "a.txt", oldText: "x", newText: "y" }];
		const prepared = patchTool.prepareArguments?.({ edits: JSON.stringify(edits) });
		assert.deepEqual(prepared, { edits });
	});
});
