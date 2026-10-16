import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { askYesNo } from "../../src/cli/prompt.ts";

/** 造一对内存流，喂一个答案进去，返回结论与屏幕上出现的问题。 */
async function ask(answer: string): Promise<{ readonly allowed: boolean; readonly prompt: string }> {
	const input = new PassThrough();
	const output = new PassThrough();
	const chunks: string[] = [];
	output.on("data", (chunk) => chunks.push(String(chunk)));

	const pending = askYesNo("要读取工作区自带的配置吗？", { input, output });
	if (answer !== "") input.write(answer);
	// 回车才是回答结束
	input.write("\n");

	const allowed = await pending;
	return { allowed, prompt: chunks.join("") };
}

describe("进入界面前的询问", () => {
	it("问题带出默认值，答案默认是否", async () => {
		const { prompt } = await ask("y");
		assert.ok(prompt.includes("要读取工作区自带的配置吗？"));
		assert.ok(prompt.includes("[y/N]"));
	});

	it("只认明确的肯定", async () => {
		assert.equal((await ask("y")).allowed, true);
		assert.equal((await ask("Y")).allowed, true);
		assert.equal((await ask("yes")).allowed, true);
		assert.equal((await ask("  YES  ")).allowed, true);
	});

	it("其余一律按否处理", async () => {
		assert.equal((await ask("n")).allowed, false);
		assert.equal((await ask("")).allowed, false);
		assert.equal((await ask("好")).allowed, false);
		assert.equal((await ask("yeah")).allowed, false);
	});

	it("答案还没给就读到结束，按否处理", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const pending = askYesNo("要不要？", { input, output });
		input.end();
		assert.equal(await pending, false);
	});
});
