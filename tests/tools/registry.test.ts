import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { AnyToolDefinition } from "../../src/tools/contract.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { createTestWorkspace, expectFailure, type TestWorkspace } from "./helpers.ts";

const spillDirectory = mkdtempSync(join(tmpdir(), "reins-registry-spill-"));
const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
	rmSync(spillDirectory, { recursive: true, force: true });
});

/** 一个最小工具：把收到的一个字符串参数原样返回。 */
function echoTool(overrides: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
	return {
		name: "echo",
		description: "回显",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		annotations: { readOnly: true, destructive: false, openWorld: false },
		async execute({ args }) {
			return { content: String(args["text"]) };
		},
		...overrides,
	};
}

function registry(spillThreshold = 0): ToolRegistry {
	return new ToolRegistry(new ResultSpiller(spillThreshold, spillDirectory));
}

describe("工具注册", () => {
	it("重复注册同名工具会报错", () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		assert.throws(() => tools.register(echoTool(), "core"), /重复注册/);
	});

	it("插件不得替换核心工具", () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		assert.throws(() => tools.register(echoTool(), "plugin"), /不能被插件替换/);
	});

	it("插件之间同名也报错", () => {
		const tools = registry();
		tools.register(echoTool(), "plugin");
		assert.throws(() => tools.register(echoTool(), "plugin"), /重复注册/);
	});

	it("列出工具与来源", () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		assert.deepEqual(tools.describe(), [{ name: "echo", source: "core" }]);
		assert.equal(tools.list().length, 1);
		assert.equal(tools.get("echo")?.name, "echo");
		assert.equal(tools.get("missing"), undefined);
	});
});

describe("调用管线", () => {
	it("正常执行并返回内容", async () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		const outcome = await tools.call(
			{ callId: "c1", name: "echo", args: { text: "甲" } },
			workspace.context(undefined),
		);
		assert.equal(outcome.content, "甲");
		assert.equal(outcome.isError, false);
	});

	it("未知工具时列出可用的名字", async () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		const outcome = await tools.call(
			{ callId: "c1", name: "missing", args: {} },
			workspace.context(undefined),
		);
		expectFailure(outcome, "没有名为 missing 的工具");
		assert.ok(outcome.content.includes("echo"));
	});

	it("参数不合模式时报错，并回显收到的参数", async () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		const outcome = await tools.call(
			{ callId: "c1", name: "echo", args: { text: 42 } },
			workspace.context(undefined),
		);
		expectFailure(outcome, "参数有误");
		assert.ok(outcome.content.includes("应当是字符串"));
		assert.ok(outcome.content.includes('{"text":42}'));
	});

	it("缺少必填参数时报错", async () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		const outcome = await tools.call({ callId: "c1", name: "echo", args: {} }, workspace.context(undefined));
		expectFailure(outcome, "缺少必填的 text");
	});

	it("多余的参数被拒，帮模型发现自己把参数名写错了", async () => {
		const tools = registry();
		tools.register(echoTool(), "core");
		const outcome = await tools.call(
			{ callId: "c1", name: "echo", args: { text: "a", extra: 1 } },
			workspace.context(undefined),
		);
		expectFailure(outcome, "未知的 extra");
	});

	it("先经过 prepareArguments 再校验", async () => {
		const tools = registry();
		tools.register(
			echoTool({
				prepareArguments: (args) => ({ text: String(args["text"] ?? "") }),
			}),
			"core",
		);
		const outcome = await tools.call(
			{ callId: "c1", name: "echo", args: { text: "补上" } },
			workspace.context(undefined),
		);
		assert.equal(outcome.isError, false);
	});

	it("工具抛错时转成错误结果，不中断整轮对话", async () => {
		const tools = registry();
		tools.register(
			echoTool({
				name: "boom",
				async execute() {
					throw new Error("炸了");
				},
			}),
			"core",
		);
		const outcome = await tools.call(
			{ callId: "c1", name: "boom", args: { text: "x" } },
			workspace.context(undefined),
		);
		expectFailure(outcome, "工具执行失败：炸了");
	});

	it("超过阈值的结果被落盘", async () => {
		const tools = registry(20);
		tools.register(
			echoTool({
				name: "big",
				async execute() {
					return { content: "字".repeat(200) };
				},
			}),
			"core",
		);
		const outcome = await tools.call(
			{ callId: "c1", name: "big", args: { text: "x" } },
			workspace.context(undefined),
		);
		assert.ok(outcome.content.includes("已写入"));
		assert.ok(outcome.content.includes("已省略"));
	});
});
