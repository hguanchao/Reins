import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { TurnDriver } from "../../src/agent/driver.ts";
import { Compactor } from "../../src/agent/compactor.ts";
import type { AgentEvent } from "../../src/agent/events.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { parseModels } from "../../src/config/models-file.ts";
import type { LlmResult } from "../../src/llm/client.ts";
import { Session } from "../../src/session/session.ts";
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

/** 装配一份测试用的驱动。默认没有压缩器：压缩要显式开口，免得别的用例悄悄被它影响。 */
function fixtures(
	script: readonly LlmResult[],
	options: { readonly configText?: string; readonly withCompactor?: boolean } = {},
): {
	readonly client: ScriptedClient;
	readonly session: Session;
	readonly events: AgentEvent[];
	readonly driver: TurnDriver;
} {
	const config = parseConfig(
		options.configText ?? 'provider = "p"\nmodel = "test-model"\nspill_threshold = 0\n',
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
	const session = new Session({ file: null, id: "test", cwd: workspace.root });
	const events: AgentEvent[] = [];

	// 摘要也走这个脚本：压缩请求与正式请求共用一份脚本，顺序就是实际发生的顺序
	const compactor =
		options.withCompactor === true
			? new Compactor({
					client,
					provider: "p",
					model,
					contextWindow: config.contextWindow ?? 1000,
					maxTokens: config.maxTokens,
				})
			: undefined;

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
		...(compactor === undefined ? {} : { compactor }),
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
		const { session, driver, events } = fixtures([truncated, textResult("好的")]);

		await driver.run("读一下", new AbortController().signal);

		const result = session.state().messages[2];
		assert.equal(result.role, "toolResult");
		assert.equal(result.role === "toolResult" ? result.isError : false, true);
		assert.match(result.role === "toolResult" ? result.content : "", /被长度上限截断/);
		assert.ok(!session.state().messages.some((message) => message.role === "toolResult" && message.content === "不该被读到"));

		// 界面上也要看得到这件事：否则使用者只看到这一轮突然停下
		const ended = events.filter((event) => event.type === "tool_end");
		assert.equal(ended.length, 1);
		assert.equal(ended[0].type === "tool_end" ? ended[0].isError : false, true);
		assert.match(ended[0].type === "tool_end" ? ended[0].summary : "", /被长度上限截断/);
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

describe("用量记录", () => {
	it("每轮把用量记成条目，它不进上下文", async () => {
		const { session, client, driver } = fixtures([textResult("你好")]);
		await driver.run("打个招呼", new AbortController().signal);

		const usageEntries = session.entries().filter((entry) => entry.type === "usage");
		assert.equal(usageEntries.length, 1);
		assert.equal(usageEntries[0].type === "usage" ? usageEntries[0].kind : "", "turn");
		assert.equal(usageEntries[0].type === "usage" ? usageEntries[0].usage.total : 0, 15);

		// 上下文里只有那两句对话
		assert.equal(session.state().messages.length, 2);
		// 第二次请求带的是同一份上下文，用量条目没有混进去
		assert.equal(client.requests.length, 1);
	});

	it("端点没有回报用量时不记空账", async () => {
		const { session, driver } = fixtures([{ ...textResult("你好"), usage: undefined }]);
		await driver.run("打个招呼", new AbortController().signal);
		assert.equal(session.entries().filter((entry) => entry.type === "usage").length, 0);
	});
});

describe("上下文压缩", () => {
	/** 上限 400：超过 320 就压；保留额度 100，只留得下最近的一点内容。 */
	const config =
		'provider = "p"\nmodel = "test-model"\ncontext_window = 400\ncompact_model = "test-model"\nspill_threshold = 0\n';

	it("接近上限时先压缩再请求，被摘要掉的消息仍在条目里", async () => {
		workspace.writeFile("big.txt", "字".repeat(200));
		const script: LlmResult[] = [
			{
				...toolCallResult({ id: "call_1", name: "read", arguments: { path: "big.txt" } }),
				usage: { input: 400, output: 20, cacheRead: 0, cacheWrite: 0, total: 420 },
			},
			textResult("上下文已经交代清楚"),
			textResult("读到了"),
		];
		const { session, client, events, driver } = fixtures(script, { configText: config, withCompactor: true });

		await driver.run("读一下 big.txt", new AbortController().signal);

		// 三次请求：工具那一轮、摘要、压缩后的正式请求
		assert.equal(client.requests.length, 3);
		const summarized = client.requests[1];
		assert.equal(summarized.model, "test-model");
		assert.deepEqual(summarized.tools, []);
		const after = client.requests[2].messages;
		assert.equal(after[0].role, "user");
		assert.match(JSON.stringify(after[0]), /摘要/);

		// 摘要写进了会话，被覆盖的消息退出上下文但条目还在
		const compaction = session.entries().find((entry) => entry.type === "compaction");
		assert.ok(compaction !== undefined);
		assert.equal(compaction.type === "compaction" ? compaction.summary : "", "上下文已经交代清楚");
		assert.deepEqual(compaction.type === "compaction" ? compaction.covered : [], [
			session.entries().find((entry) => entry.type === "message")?.id ?? "",
		]);
		const state = session.state();
		assert.ok(!JSON.stringify(state.messages).includes("读一下 big.txt"), "被摘要掉的消息不该还在上下文里");
		// 摘要占着原来那条消息的位置，条目本身仍在文件里
		assert.equal(state.messageIds[0], compaction.id);
		assert.ok(session.entries().some((entry) => entry.type === "message" && JSON.stringify(entry).includes("读一下 big.txt")));

		// 摘要那次请求的用量也记下来，夹在两次正式请求之间
		const kinds = session.entries().flatMap((entry) => (entry.type === "usage" ? [entry.kind] : []));
		assert.deepEqual(kinds, ["turn", "compact", "turn"]);

		const types = events.map((event) => event.type);
		assert.ok(types.includes("compaction_start"));
		assert.ok(types.includes("compaction_end"));
		assert.ok(!types.includes("compaction_failed"));
	});

	it("接续来的长会话在第一次请求之前就先压缩：没有回报的用量可参考，只能靠估算", async () => {
		const script: LlmResult[] = [textResult("先前读了很长的内容"), textResult("接着说")];
		const { session, client, events, driver } = fixtures(script, { configText: config, withCompactor: true });

		// 承接一份很长的历史：这模拟的就是 --continue 进来的情形
		for (let index = 0; index < 6; index += 1) {
			await session.append({ type: "message", message: { role: "user", content: `第 ${index} 段：${"字".repeat(120)}` } });
		}

		await driver.run("接着来", new AbortController().signal);

		// 第一次请求是摘要，第二次才是正式请求；正式请求以摘要开头
		assert.equal(client.requests.length, 2);
		assert.equal(client.requests[1].messages.length, 2);
		assert.match(JSON.stringify(client.requests[1].messages[0]), /摘要/);

		const types = events.map((event) => event.type);
		assert.ok(types.indexOf("compaction_start") < types.indexOf("turn_start"), types.join("、"));
		assert.ok(types.includes("compaction_end"));
	});

	it("压缩失败时如实说明，上下文照原样继续", async () => {
		workspace.writeFile("big.txt", "字".repeat(200));
		const script: LlmResult[] = [
			{
				...toolCallResult({ id: "call_1", name: "read", arguments: { path: "big.txt" } }),
				usage: { input: 400, output: 20, cacheRead: 0, cacheWrite: 0, total: 420 },
			},
			errorResult("端点连不上"),
			textResult("读到了"),
		];
		const { session, client, events, driver } = fixtures(script, { configText: config, withCompactor: true });

		await driver.run("读一下 big.txt", new AbortController().signal);

		assert.equal(session.entries().filter((entry) => entry.type === "compaction").length, 0);
		// 第二次请求带着完整上下文，没有被削掉
		assert.equal(client.requests[2].messages.length, 3);
		assert.match(JSON.stringify(client.requests[2].messages[0]), /读一下 big\.txt/);
		const failed = events.find((event) => event.type === "compaction_failed");
		assert.match(failed?.type === "compaction_failed" ? failed.message : "", /端点连不上/);
	});

	it("没有声明上下文上限时不压缩，历史照原样发出去", async () => {
		workspace.writeFile("big.txt", "字".repeat(200));
		const script: LlmResult[] = [
			{
				...toolCallResult({ id: "call_1", name: "read", arguments: { path: "big.txt" } }),
				usage: { input: 400, output: 20, cacheRead: 0, cacheWrite: 0, total: 420 },
			},
			textResult("读到了"),
		];
		const { session, client, driver } = fixtures(script);

		await driver.run("读一下 big.txt", new AbortController().signal);

		assert.equal(client.requests.length, 2);
		assert.equal(session.entries().filter((entry) => entry.type === "compaction").length, 0);
	});
});
