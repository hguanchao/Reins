import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commandCore } from "../../src/tools/command-summary.ts";

/**
 * 命令折叠摘要。
 *
 * 关键是不能误剥：`cd` 到别处、相对路径、复合语句都必须原样保留，否则展开前的摘要会
 * 说错命令在哪里跑。
 */
describe("命令折叠摘要", () => {
	const root = "/e/Projects/Reins2API";

	it("剥掉指向工作根的 cd，保留第一段命令", () => {
		assert.equal(
			commandCore(`cd ${root} && npm run build 2>&1 | tail -15`, root),
			"npm run build",
		);
		assert.equal(commandCore(`cd ${root}; ls -la`, root), "ls -la");
	});

	it("Windows 盘符与 Git Bash 路径视为同一处", () => {
		assert.equal(commandCore("cd /e/Projects/Reins2API && npm ci", "E:\\Projects\\Reins2API"), "npm ci");
		assert.equal(commandCore("cd E:/Projects/Reins2API && npm ci", root), "npm ci");
	});

	it("进了子目录的 cd 留成前缀", () => {
		assert.equal(commandCore(`cd ${root}/server && pytest`, root), "[server] pytest");
		assert.equal(commandCore("cd web && npm run build", root), "[web] npm run build");
		assert.equal(
			commandCore("cd /e/Projects/Reins2API/server && pytest", "E:\\Projects\\Reins2API"),
			"[server] pytest",
		);
	});

	it("不是工作根的 cd 原样保留", () => {
		assert.equal(commandCore("cd /tmp && ls", root), "cd /tmp && ls");
		assert.equal(commandCore("cd /e/Projects/Other && ls", root), "cd /e/Projects/Other && ls");
	});

	it("相对路径的 cd 留成作用域标签", () => {
		assert.equal(commandCore("cd proj && ls", root), "[proj] ls");
	});

	it("复合结构整条保留", () => {
		const command = `cd ${root} && for f in *.py; do echo "$f"; done`;
		assert.equal(commandCore(command, root), "for f in *.py; do echo \"$f\"; done");
	});

	it("跳过只为分隔输出的 echo，取下一条有内容的命令", () => {
		assert.equal(
			commandCore(`cd ${root} && echo "=== docs ===" && ls docs`, root),
			"ls docs",
		);
	});

	it("去掉段尾的重定向", () => {
		assert.equal(commandCore(`cd ${root} && pytest 2>&1`, root), "pytest");
		assert.equal(commandCore("pytest > /dev/null 2>&1", root), "pytest");
	});

	it("引号里的分隔符不切段", () => {
		assert.equal(
			commandCore(`cd ${root} && grep -n "a && b" src`, root),
			'grep -n "a && b" src',
		);
	});

	it("没有工作根时只按结构折叠", () => {
		assert.equal(commandCore("npm test | tail -5"), "npm test");
		// 绝对路径的 cd 不给作用域前缀，原样保留
		assert.equal(commandCore("cd /anywhere && ls"), "cd /anywhere && ls");
	});

	it("剥完没有内容时退回原命令", () => {
		assert.equal(commandCore(`cd ${root}`, root), `cd ${root}`);
	});
});
