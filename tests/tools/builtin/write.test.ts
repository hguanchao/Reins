import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { writeTool } from "../../../src/tools/builtin/write.ts";
import { createTestWorkspace, expectFailure, expectSuccess, type TestWorkspace } from "../helpers.ts";

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

describe("write 工具", () => {
	it("创建文件并报告字节数", async () => {
		const result = await writeTool.execute(workspace.context({ path: "new.txt", content: "内容" }));
		expectSuccess(result);
		assert.ok(result.content.startsWith("已创建 new.txt"));
		assert.equal(workspace.readFile("new.txt"), "内容");
	});

	it("覆盖已有文件并说明原有大小", async () => {
		workspace.writeFile("exist.txt", "旧内容长一些");
		const result = await writeTool.execute(workspace.context({ path: "exist.txt", content: "新" }));
		assert.ok(result.content.includes("已覆盖 exist.txt"));
		assert.ok(result.content.includes("原有"));
		assert.equal(workspace.readFile("exist.txt"), "新");
	});

	it("自动创建父目录", async () => {
		const result = await writeTool.execute(workspace.context({ path: "a/b/c.txt", content: "x" }));
		expectSuccess(result);
		assert.equal(workspace.readFile("a/b/c.txt"), "x");
	});

	it("允许写入空内容", async () => {
		const result = await writeTool.execute(workspace.context({ path: "blank.txt", content: "" }));
		expectSuccess(result);
		assert.equal(workspace.readFile("blank.txt"), "");
	});

	it("目标是目录时报错", async () => {
		mkdirSync(join(workspace.root, "adir"), { recursive: true });
		const result = await writeTool.execute(workspace.context({ path: "adir", content: "x" }));
		expectFailure(result, "是一个目录，不能写入");
	});

	it("沙箱拒绝写入时把理由带出来", async () => {
		// 工具只管抛错，归一成错误结果是调用管线（注册表）的职责
		await assert.rejects(
			() =>
				writeTool.execute({
					...workspace.context({ path: "guarded.txt", content: "x" }),
					sandbox: {
						assertPathAllowed: () => {
							throw new Error("该路径被策略禁止写入");
						},
						wrapCommand: (command: string) => command,
					},
				}),
			/该路径被策略禁止写入/,
		);
	});

	it("结构化结果标出是新建还是覆盖", async () => {
		const created = await writeTool.execute(workspace.context({ path: "s1.txt", content: "x" }));
		assert.deepEqual(created.details, { path: "s1.txt", bytes: 1, created: true });

		const overwritten = await writeTool.execute(workspace.context({ path: "s1.txt", content: "xy" }));
		assert.deepEqual(overwritten.details, { path: "s1.txt", bytes: 2, created: false });
	});
});
