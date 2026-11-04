import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	WORKSPACE_NAME_LIMIT,
	readWorkspaceNames,
	workspaceNameOf,
	writeWorkspaceName,
} from "#src/workspace/name.ts";

/** 每个用例各自一个临时目录，免去共享状态。 */
function namesFile(name: string): string {
	const suffix = Math.random().toString(16).slice(2);
	const directory = join(tmpdir(), `reins-workspace-name-${name}-${suffix}`);
	mkdirSync(directory, { recursive: true });
	return join(directory, "workspace-names.json");
}

describe("工作区显示名", () => {
	it("写进去能读回来，按路径分别记", () => {
		const file = namesFile("roundtrip");
		assert.equal(writeWorkspaceName(file, "/work/a", "登录重构"), true);
		assert.equal(writeWorkspaceName(file, "/work/b", "文档站"), true);
		assert.equal(workspaceNameOf(file, "/work/a"), "登录重构");
		assert.equal(workspaceNameOf(file, "/work/b"), "文档站");
	});

	it("没改过名的目录没有名字", () => {
		const file = namesFile("missing");
		assert.equal(workspaceNameOf(file, "/work/unknown"), undefined);
		assert.equal(workspaceNameOf(file, undefined), undefined);
	});

	it("名字去掉首尾空白再存", () => {
		const file = namesFile("trim");
		assert.equal(writeWorkspaceName(file, "/work/a", "  前后有空格  "), true);
		assert.equal(workspaceNameOf(file, "/work/a"), "前后有空格");
	});

	it("空白名字当场拒绝，不落盘", () => {
		const file = namesFile("blank");
		assert.equal(writeWorkspaceName(file, "/work/a", "   "), false);
		assert.equal(workspaceNameOf(file, "/work/a"), undefined);
	});

	it("超过长度上限的名字拒绝", () => {
		const file = namesFile("long");
		assert.equal(writeWorkspaceName(file, "/work/a", "x".repeat(WORKSPACE_NAME_LIMIT + 1)), false);
		assert.equal(writeWorkspaceName(file, "/work/a", "x".repeat(WORKSPACE_NAME_LIMIT)), true);
	});

	it("文件坏掉时当空表，改名仍可用", () => {
		const file = namesFile("broken");
		writeFileSync(file, "{ 这不是 JSON");
		assert.deepEqual(readWorkspaceNames(file), {});
		assert.equal(writeWorkspaceName(file, "/work/a", "还能改名"), true);
		assert.equal(workspaceNameOf(file, "/work/a"), "还能改名");
	});

	it("表里混进非字符串值时跳过它，其余照常读", () => {
		const file = namesFile("mixed");
		writeFileSync(file, JSON.stringify({ "/work/a": "好的", "/work/b": 42, "/work/c": null }));
		assert.deepEqual(readWorkspaceNames(file), { "/work/a": "好的" });
	});

	it("整个文件是数组时也当空表", () => {
		const file = namesFile("array");
		writeFileSync(file, JSON.stringify(["nope"]));
		assert.deepEqual(readWorkspaceNames(file), {});
	});
});
