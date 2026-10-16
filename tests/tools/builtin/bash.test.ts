import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { bashTool } from "../../../src/tools/builtin/bash.ts";
import { createTestWorkspace, expectFailure, expectSuccess, type TestWorkspace } from "../helpers.ts";

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

/**
 * 用脚本文件而不是内联代码来构造命令。
 *
 * 内联的引号在 cmd.exe 与 POSIX shell 里规则不同，测试会变成在测引号而不是在测工具本身。
 */
function script(name: string, body: string): string {
	workspace.writeFile(name, body);
	return `node ${name}`;
}

describe("bash 工具", () => {
	it("执行命令并返回输出", async () => {
		const result = await bashTool.execute(
			workspace.context({ command: script("hi.js", 'console.log("你好");') }),
		);
		expectSuccess(result);
		assert.ok(result.content.includes("你好"));
	});

	it("合并标准输出与标准错误", async () => {
		const result = await bashTool.execute(
			workspace.context({
				command: script("both.js", 'console.log("正常"); console.error("错误");'),
			}),
		);
		assert.ok(result.content.includes("正常"));
		assert.ok(result.content.includes("错误"));
	});

	it("非零退出码算失败，并带上退出码", async () => {
		const result = await bashTool.execute(
			workspace.context({ command: script("fail.js", 'console.error("出错了"); process.exit(3);') }),
		);
		expectFailure(result, "[命令以退出码 3 结束]");
		assert.ok(result.content.includes("出错了"));
	});

	it("没有输出时明确说明", async () => {
		const result = await bashTool.execute(workspace.context({ command: script("quiet.js", "") }));
		assert.ok(result.content.includes("[命令没有输出]"));
	});

	it("超时后终止命令并说明", async () => {
		const result = await bashTool.execute(
			workspace.context({ command: script("sleep.js", "setTimeout(() => {}, 30000);"), timeout: 1 }),
		);
		expectFailure(result, "超过 1 秒未结束");
		assert.equal((result.details as { timedOut: boolean }).timedOut, true);
	});

	it("中止信号到达时结束命令", async () => {
		const controller = new AbortController();
		const running = bashTool.execute(
			workspace.context(
				{ command: script("wait.js", "setTimeout(() => {}, 30000);") },
				{ signal: controller.signal },
			),
		);
		setTimeout(() => controller.abort(), 50);

		const result = await running;
		expectFailure(result, "[已中止]");
	});

	it("工作目录是工作根", async () => {
		const result = await bashTool.execute(
			workspace.context({ command: script("cwd.js", 'console.log(process.cwd());') }),
		);
		assert.ok(result.content.includes(workspace.root.replaceAll("\\", "\\\\")) || result.content.includes(workspace.root));
	});

	it("沙箱包装后的命令才是实际执行的命令", async () => {
		const result = await bashTool.execute({
			...workspace.context({ command: "不会被执行" }),
			sandbox: {
				assertPathAllowed: () => undefined,
				// 用一个能跑通且能看出被替换过的命令
				wrapCommand: () => script("wrapped.js", 'console.log("来自包装后的命令");'),
			},
		});
		assert.ok(result.content.includes("来自包装后的命令"));
	});

	it("把会话标识透给子进程", async () => {
		const result = await bashTool.execute(
			workspace.context({
				command: script("env.js", "console.log(process.env.REINS_SESSION_ID);"),
			}),
		);
		assert.ok(result.content.includes("test-session"));
	});
});
