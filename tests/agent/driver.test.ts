import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { TurnDriver } from "../../src/agent/driver.ts";
import type { AgentEvent } from "../../src/agent/events.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { parseModels } from "../../src/config/models-file.ts";
import type { LlmResult } from "../../src/llm/client.ts";
import { JsonlSession } from "../../src/plugins/session-plugin/jsonl-store.ts";
import { Sandbox } from "../../src/sandbox/policy.ts";
import { createCoreTools } from "../../src/tools/builtin/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { WorkspaceBoundary } from "../../src/workspace/boundary.ts";
import { allowAllGate, createTestWorkspace, type TestWorkspace } from "../tools/helpers.ts";
import { ScriptedClient, errorResult, textResult, toolCallResult } from "./scripted-client.ts";

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

function fixtures(script: readonly LlmResult[]): {
	readonly client: ScriptedClient;
	readonly session: JsonlSession;
	readonly events: AgentEvent[];
	readonly driver: TurnDriver;
} {
	const config = parseConfig(
		'provider = "p"\nmodel = "test-model"\nspill_threshold = 0\n',
		"config.toml",
	);
	const models = parseModels(
		JSON.stringify({
			providers: {
				p: { baseUrl: "https://x", api: "openai-completions", models: [{ id: "test-model" }] },
			},
		}),
		"models.json",
	);
	const provider = models.providers[0];
	const model = provider.models[0];

	const tools = new ToolRegistry(new ResultSpiller(0, workspace.root), allowAllGate);
	for (const tool of createCoreTools()) tools.register(tool, "core");

	const client = new ScriptedClient(script);
	const session = new JsonlSession({ file: null, id: "test", cwd: workspace.root });
	const events: AgentEvent[] = [];

	const driver = new TurnDriver({
		provider,
		model,
		config,
		client,
		tools,
		session,
		workspace: new WorkspaceBoundary(workspace.root),
		sandbox: new Sandbox({ mode: "off", root: workspace.root }, undefined),
		onEvent: (event) => {
			events.push(event);
		},
	});

	return { client, session, events, driver };
}

describe("回合驱动", () => {
	it("只说话时一轮就结束", async () => {
		const { client, session, events, driver } = fixtures([textResult("你好")]);
		await driver.run("打个招呼", new AbortController().signal);

		assert.equal(client.requests.length, 1);
		assert.equal(session.state().messages.length, 2);
		assert.deepEqual(session.state().messages[1], {
			role: "assistant",
			content: [{ type: "text", text: "你好" }],
		});
		assert.deepEqual(
			events.map((event) => event.type),
			["turn_start", "text_delta", "turn_end", "run_end"],
		);
	});

	it("要求调用工具时执行完再问一次", async () => {
		workspace.writeFile("target.txt", "原文");
		const { client, events, session, driver } = fixtures([
			toolCallResult({ id: "call_1", name: "read", arguments: { path: "target.txt" } }),
			textResult("内容是：原文"),
		]);

		await driver.run("看看 target.txt", new AbortController().signal);

		assert.equal(client.requests.length, 2);
		const types = events.map((event) => event.type);
		assert.ok(types.includes("tool_start"));
		assert.ok(types.includes("tool_end"));

		const messages = session.state().messages;
		assert.equal(messages.length, 4);
		assert.deepEqual(messages[2], {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: "原文",
			isError: false,
		});
	});

	it("工具结果按模型给出的顺序写回，尽管执行是并行的", async () => {
		workspace.writeFile("a.txt", "甲");
		workspace.writeFile("b.txt", "乙");
		const calls = [
			{ id: "call_1", name: "read", arguments: { path: "a.txt" } },
			{ id: "call_2", name: "read", arguments: { path: "b.txt" } },
		];
		const { session, driver } = fixtures([
			{ ...toolCallResult(calls[0]), content: calls.map((call) => ({ type: "toolCall" as const, ...call })) },
			textResult("都看到了"),
		]);

		await driver.run("都读一下", new AbortController().signal);

		const results = session
			.state()
			.messages.filter((message) => message.role === "toolResult")
			.map((message) => (message.role === "toolResult" ? message.toolCallId : ""));
		assert.deepEqual(results, ["call_1", "call_2"]);
	});

	it("输出被长度上限截断时不执行工具，并把原因交回模型", async () => {
		workspace.writeFile("c.txt", "不该被读到");
		const truncated: LlmResult = {
			...toolCallResult({ id: "call_1", name: "read", arguments: { path: "c.txt" } }),
			stopReason: "length",
		};
		const { session, driver } = fixtures([truncated, textResult("好的")]);

		await driver.run("读一下", new AbortController().signal);

		const result = session.state().messages[2];
		assert.equal(result.role, "toolResult");
		assert.equal(result.role === "toolResult" ? result.isError : false, true);
		assert.match(result.role === "toolResult" ? result.content : "", /被长度上限截断/);
		assert.ok(!session.state().messages.some((message) => message.role === "toolResult" && message.content === "不该被读到"));
	});

	it("参数不是合法 JSON 时不拿空对象去执行", async () => {
		const { session, driver } = fixtures([
			{
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "read",
						arguments: {},
						argumentsError: "工具参数不是合法 JSON",
					},
				],
				usage: undefined,
				stopReason: "toolUse",
				errorMessage: undefined,
				model: "test-model",
			},
			textResult("我重发一次"),
		]);

		await driver.run("读一下", new AbortController().signal);

		const result = session.state().messages[2];
		assert.equal(result.role, "toolResult");
		assert.match(result.role === "toolResult" ? result.content : "", /不是合法 JSON/);
	});

	it("模型返回错误时结束本次运行并发出错误事件", async () => {
		const { events, session, driver } = fixtures([errorResult("额度不足")]);
		await driver.run("做事", new AbortController().signal);

		const error = events.find((event) => event.type === "error");
		assert.ok(error !== undefined);
		assert.match(error.type === "error" ? error.message : "", /额度不足/);
		assert.equal(events[events.length - 1].type, "run_end");
		// 出错的那一轮不写进历史：它没有可用的内容
		assert.equal(session.state().messages.length, 1);
	});

	it("把提示词分段、工具声明与模型记录进会话", async () => {
		const { session, driver } = fixtures([textResult("好")]);
		await driver.run("打个招呼", new AbortController().signal);

		const state = session.state();
		assert.ok(state.sections["preamble"]?.includes("编码助手"));
		assert.ok(state.sections["tools"]?.includes("read"));
		assert.ok(state.sections["cwd"]?.includes(workspace.root));
		assert.deepEqual(state.model, { provider: "p", model: "test-model" });
		assert.equal(state.effort, "off");
	});

	it("状态没有变化时不重复写系统条目", async () => {
		const { session, driver } = fixtures([textResult("一"), textResult("二")]);
		await driver.run("第一次", new AbortController().signal);
		const afterFirst = session.entries().length;
		await driver.run("第二次", new AbortController().signal);

		const systemEntries = session
			.entries()
			.filter((entry) => entry.type === "system");
		const modelEntries = session.entries().filter((entry) => entry.type === "model_change");
		assert.equal(systemEntries.length, 1);
		assert.equal(modelEntries.length, 1);
		assert.ok(session.entries().length > afterFirst);
	});
});
