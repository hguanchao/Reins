import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { writeScope } from "../../src/tools/path.ts";
import type { WorkspaceBoundary } from "../../src/workspace/boundary.ts";

const ROOT = resolve("work");

const WORKSPACE = {
	root: ROOT,
	resolve: (input: string) => ({ absolute: resolve(ROOT, input) }),
	display: (absolute: string) => absolute.slice(ROOT.length + 1).replaceAll("\\", "/"),
} as WorkspaceBoundary;

describe("写工具审批范围", () => {
	it("键与展示都用解析后的绝对路径", () => {
		const scope = writeScope(WORKSPACE, "src/a.ts");
		assert.equal(scope.key, resolve(ROOT, "src/a.ts"));
		assert.equal(scope.label, "src/a.ts");
		assert.equal(scope.short, scope.label);
	});

	it("相对写法不同、指向同一文件时键相同", () => {
		assert.equal(writeScope(WORKSPACE, "./src/a.ts").key, writeScope(WORKSPACE, "src/a.ts").key);
	});
});
