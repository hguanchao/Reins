import assert from "node:assert/strict";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { describe, it } from "node:test";

import { expandHome, resolveWorkRoot, toAbsolutePath } from "#src/workspace/root.ts";

describe("工作根", () => {
	it("resolveWorkRoot 归一化", () => {
		assert.equal(resolveWorkRoot("."), resolve("."));
	});

	it("expandHome:~ 展开为用户目录", () => {
		assert.equal(expandHome("~"), homedir());
		const joined = expandHome("~/docs");
		assert.ok(joined.startsWith(homedir()));
		const windowsJoined = expandHome("~\\docs");
		assert.ok(windowsJoined.startsWith(homedir()));
	});

	it("expandHome:其余原样返回", () => {
		assert.equal(expandHome("rel/path"), "rel/path");
		assert.equal(expandHome("~middle"), "~middle"); // 只认开头
	});

	it("toAbsolutePath:绝对路径原样归一化", () => {
		const absolute = isAbsolute("E:\\x") ? "E:\\x\\a.ts" : resolve("a.ts");
		assert.equal(toAbsolutePath(absolute, "/w"), resolve(absolute));
	});

	it("toAbsolutePath:相对路径按工作根解析", () => {
		const result = toAbsolutePath("a.ts", "/w");
		assert.ok(isAbsolute(result));
		assert.ok(result.endsWith("a.ts"));
	});

	it("toAbsolutePath:.. 向上跳出", () => {
		const result = toAbsolutePath("..", "/w/sub");
		assert.ok(result.endsWith("w"));
	});
});
