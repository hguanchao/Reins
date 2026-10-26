import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionDirectories, sessionsDir } from "../../src/config/paths.ts";

describe("会话目录编码", () => {
	it("不同工作区不会映射到同一个目录", () => {
		// 只用可读前缀是有损的：这两个路径都会变成 E--work-my-project
		const a = sessionsDir("E:\\work\\my-project");
		const b = sessionsDir("E:\\work\\my\\project");
		assert.notEqual(a, b);
	});

	it("同一个工作区每次都得到同一个目录", () => {
		assert.equal(sessionsDir("E:\\work\\proj"), sessionsDir("E:\\work\\proj"));
	});

	it("Windows 上大小写不同的同一路径得到相同的哈希", { skip: process.platform !== "win32" }, () => {
		// 可读前缀会保留使用者输入的写法，唯一性由哈希保证
		const hashOf = (path: string): string => /-([0-9a-f]{16})$/.exec(sessionsDir(path))?.[1] ?? "";
		assert.equal(hashOf("E:\\Work\\Proj"), hashOf("e:\\work\\proj"));
	});

	it("目录名保留可读前缀，便于人工排查", () => {
		assert.match(sessionsDir("E:\\work\\my-project"), /my-project-[0-9a-f]{16}$/);
	});

	it("超长路径不会让目录名过长", () => {
		const long = `E:\\${"very-long-directory-name\\".repeat(10)}project`;
		const name = sessionsDir(long).split(/[/\\]/).at(-1) ?? "";
		assert.ok(name.length <= 60, `目录名过长：${name.length}`);
	});

	it("候选目录包含旧编码，升级后历史仍找得到", () => {
		const directories = sessionDirectories("E:\\work\\my-project");
		assert.equal(directories.length, 2);
		assert.match(directories[0] ?? "", /my-project-[0-9a-f]{16}$/);
		assert.match(directories[1] ?? "", /E--work-my-project$/);
	});

	it("没有旧编码差异时只给一个候选", () => {
		// 旧编码与当前编码相同时不该重复列两遍
		const directories = sessionDirectories("E:\\work\\my-project");
		assert.equal(new Set(directories).size, directories.length);
	});
});
