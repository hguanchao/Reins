import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { findTool } from "../../../src/plugins/tools-plugin/find.ts";
import { grepTool } from "../../../src/plugins/tools-plugin/grep.ts";
import { lsTool } from "../../../src/plugins/tools-plugin/ls.ts";
import { globToRegExp, toPosix, walk } from "../../../src/plugins/tools-plugin/walk.ts";
import { createTestWorkspace, expectFailure, expectSuccess, type TestWorkspace } from "../../tools/helpers.ts";

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

function seed(): void {
	workspace.writeFile("readme.md", "# 标题\n");
	workspace.writeFile("src/main.ts", 'export const answer = 42;\nconsole.log("启动");\n');
	workspace.writeFile("src/util/helper.ts", "export function helper() {}\n");
	workspace.writeFile("src/notes.txt", "没有答案\n");
	mkdirSync(join(workspace.root, "node_modules"), { recursive: true });
	workspace.writeFile("node_modules/dep.ts", "不该被看到\n");
	mkdirSync(join(workspace.root, ".git"), { recursive: true });
	workspace.writeFile(".git/config.ts", "不该被看到\n");
}

describe("目录遍历", () => {
	it("跳过版本控制与依赖目录", () => {
		seed();
		const relativePaths = [...walk(workspace.root, { maxEntries: 100 })].map((entry) => entry.relative);
		assert.ok(relativePaths.includes("readme.md"));
		assert.ok(relativePaths.includes("src/main.ts"));
		assert.ok(!relativePaths.some((path) => path.startsWith("node_modules/")));
		assert.ok(!relativePaths.some((path) => path.startsWith(".git/")));
	});

	it("达到上限即停止", () => {
		seed();
		assert.equal([...walk(workspace.root, { maxEntries: 2 })].length, 2);
	});

	it("路径统一用正斜杠", () => {
		assert.equal(toPosix(join("a", "b", "c.ts")), "a/b/c.ts");
	});
});

describe("通配模式", () => {
	it("** 跨目录，* 不跨目录", () => {
		const deep = globToRegExp("**/*.ts");
		assert.ok(deep.test("main.ts"));
		assert.ok(deep.test("src/main.ts"));
		assert.ok(deep.test("src/util/helper.ts"));
		assert.ok(!deep.test("readme.md"));

		const shallow = globToRegExp("*.ts");
		assert.ok(shallow.test("main.ts"));
		assert.ok(!shallow.test("src/main.ts"));
	});

	it("? 匹配单个字符且不跨目录", () => {
		const pattern = globToRegExp("a?.ts");
		assert.ok(pattern.test("ab.ts"));
		assert.ok(!pattern.test("abc.ts"));
	});

	it("模式里的正则元字符被当作普通字符", () => {
		const pattern = globToRegExp("a+b.ts");
		assert.ok(pattern.test("a+b.ts"));
		assert.ok(!pattern.test("aab.ts"));
	});
});

describe("ls 工具", () => {
	it("列出目录，目录名带斜杠结尾", async () => {
		seed();
		const content = expectSuccess(await lsTool.execute(workspace.context({})));
		assert.ok(content.includes("readme.md"));
		assert.ok(content.includes("src/"));
		assert.ok(!content.includes("main.ts"));
	});

	it("按大小写不敏感的顺序排列", async () => {
		workspace.writeFile("sorting/Beta.txt", "");
		workspace.writeFile("sorting/alpha.txt", "");
		const content = expectSuccess(await lsTool.execute(workspace.context({ path: "sorting" })));
		assert.deepEqual(content.split("\n"), ["alpha.txt", "Beta.txt"]);
	});

	it("超过上限时说明还有多少", async () => {
		for (let index = 0; index < 5; index += 1) workspace.writeFile(`many/f${index}.txt`, "");
		const content = expectSuccess(await lsTool.execute(workspace.context({ path: "many", limit: 2 })));
		assert.ok(content.includes("共 5 项"));
	});

	it("空目录单独说明", async () => {
		mkdirSync(join(workspace.root, "void"), { recursive: true });
		assert.equal(expectSuccess(await lsTool.execute(workspace.context({ path: "void" }))), "void 是空目录");
	});

	it("不是目录时报错", async () => {
		workspace.writeFile("file.txt", "");
		expectFailure(await lsTool.execute(workspace.context({ path: "file.txt" })), "不是目录");
	});
});

describe("find 工具", () => {
	it("按模式返回相对路径", async () => {
		seed();
		const content = expectSuccess(await findTool.execute(workspace.context({ pattern: "src/**/*.ts" })));
		assert.deepEqual(content.split("\n").sort(), ["src/main.ts", "src/util/helper.ts"]);
	});

	it("没有匹配时说明检查了多少文件", async () => {
		seed();
		const content = expectSuccess(await findTool.execute(workspace.context({ pattern: "**/*.rs" })));
		assert.match(content, /没有匹配/);
		assert.match(content, /已检查 \d+ 个文件/);
	});

	it("正则元字符按字面量处理", async () => {
		seed();
		workspace.writeFile("odd/[1].ts", "");
		const content = expectSuccess(await findTool.execute(workspace.context({ pattern: "odd/[1].ts" })));
		assert.equal(content, "odd/[1].ts");
	});
});

describe("grep 工具", () => {
	it("返回相对路径、行号与该行内容", async () => {
		seed();
		const content = expectSuccess(await grepTool.execute(workspace.context({ pattern: "answer" })));
		assert.ok(content.includes("src/main.ts:1: export const answer = 42;"));
	});

	it("跳过依赖与版本控制目录", async () => {
		seed();
		const content = expectSuccess(await grepTool.execute(workspace.context({ pattern: "不该被看到" })));
		assert.match(content, /没有匹配/);
	});

	it("literal 为真时按普通文本匹配", async () => {
		workspace.writeFile("dots.txt", "a.b\naxb\n");
		const asRegex = expectSuccess(await grepTool.execute(workspace.context({ pattern: "a.b" })));
		assert.ok(asRegex.includes("a.b") && asRegex.includes("axb"));

		const asLiteral = expectSuccess(
			await grepTool.execute(workspace.context({ pattern: "a.b", literal: true })),
		);
		assert.ok(asLiteral.includes("dots.txt:1:"));
		assert.ok(!asLiteral.includes("axb"));
	});

	it("ignoreCase 生效", async () => {
		workspace.writeFile("case.txt", "Hello\n");
		const content = expectSuccess(
			await grepTool.execute(workspace.context({ pattern: "hello", ignoreCase: true })),
		);
		assert.ok(content.includes("case.txt:1:"));
	});

	it("glob 限定文件范围", async () => {
		seed();
		const content = expectSuccess(
			await grepTool.execute(workspace.context({ pattern: "export", glob: "**/*.ts" })),
		);
		assert.ok(!content.includes("notes.txt"));
	});

	it("达到上限时提示如何缩小范围", async () => {
		for (let index = 0; index < 5; index += 1) workspace.writeFile(`hits/h${index}.txt`, "命中\n");
		const content = expectSuccess(
			await grepTool.execute(workspace.context({ pattern: "命中", limit: 2 })),
		);
		assert.match(content, /已达到 2 条上限/);
	});

	it("非法正则被拒", async () => {
		expectFailure(await grepTool.execute(workspace.context({ pattern: "(" })), "不是合法的正则");
	});
});
