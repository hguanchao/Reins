import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { TurnDriver } from "../../src/agent/driver.ts";
import { DEFAULT_SUBAGENT_STEPS, Subagent, createSubagentTool } from "../../src/agent/subagent.ts";
import type { Config } from "../../src/config/config-file.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { parseProviders, type ModelEntry, type ProviderEntry } from "../../src/config/providers-file.ts";
import type { LlmResult } from "../../src/llm/client.ts";
import { assistantText } from "../../src/llm/messages.ts";
import { Sandbox, type SandboxView } from "../../src/sandbox/policy.ts";
import { Session } from "../../src/session/session.ts";
import { createCoreTools } from "../../src/tools/builtin/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ResultSpiller } from "../../src/tools/spill.ts";
import { WorkspaceBoundary } from "../../src/workspace/boundary.ts";
import { allowAllGate, createTestWorkspace, type TestWorkspace } from "../tools/helpers.ts";
import { ScriptedClient, errorResult, textResult, toolCallResult } from "./scripted-client.ts";

/**
 * 子代理。
 *
 * 两条要点：步数上限只约束子代理（主对话要跑多久是使用者自己的事），以及子代理的上下文与
 * 主对话隔开——主对话拿到的只有那份汇报，看不到它中途读了什么、跑了什么。
 */

const workspace: TestWorkspace = createTestWorkspace();
const BASE_CONFIG = 'provider = "p"\nmodel = "test-model"\nspill_threshold = 0\n';

after(() => {
	workspace.remove();
});

interface Fixture {
	readonly config: Config;
	readonly provider: ProviderEntry;
	readonly model: ModelEntry;
	readonly client: ScriptedClient;
	readonly registry: ToolRegistry;
	readonly session: Session;
	readonly sandbox: SandboxView;
	readonly workspace: WorkspaceBoundary;
	/** 子代理工具挂上去之后的注册表，也就是主对话实际用的那一份 */
	readonly driverTools: ToolRegistry;
}

function fixtures(configText: string, script: readonly LlmResult[]): Fixture {
	const config = parseConfig(configText, "config.toml");
	const providersConfig = parseProviders(
		JSON.stringify({
			providers: { p: { baseUrl: "https://x", api: "openai-completions", models: [{ id: "test-model" }] } },
		}),
		"providers.json",
	);
	const provider = providersConfig.providers[0];
	const model = provider.models[0];

	const client = new ScriptedClient(script);
	const registry = new ToolRegistry(new ResultSpiller(0, workspace.root), allowAllGate);
	for (const tool of createCoreTools()) registry.register(tool, "core");

	const session = new Session({ file: null, id: "test", cwd: workspace.root });
	const sandbox = new Sandbox({ mode: "off", root: workspace.root }, undefined);
	const boundary = new WorkspaceBoundary(workspace.root);

	const driverTools = registry.withExtraTool(
		createSubagentTool({
			provider,
			model,
			config,
			client,
			// 与装配处一致：交给子代理的是不含子代理工具的那一份
			tools: registry,
			session,
			maxSteps: config.maxTurns ?? DEFAULT_SUBAGENT_STEPS,
		}),
	);

	return { config, provider, model, client, registry, session, sandbox, workspace: boundary, driverTools };
}

/** 直接驱动子代理本体，不经过工具与回合驱动。 */
function subagentOf(fixture: Fixture, maxSteps: number): Subagent {
	return new Subagent({
		provider: fixture.provider,
		model: fixture.model,
		config: fixture.config,
		client: fixture.client,
		tools: fixture.registry,
		session: fixture.session,
		maxSteps,
	});
}

function contextOf(fixture: Fixture, onProgress: (text: string) => void = () => undefined) {
	return {
		workspace: fixture.workspace,
		sandbox: fixture.sandbox,
		signal: new AbortController().signal,
		onProgress,
	};
}

describe("子代理", () => {
	it("做完就把最后一段话交回，并把进度报给界面", async () => {
		workspace.writeFile("a.txt", "内容");
		const fixture = fixtures(BASE_CONFIG, [
			toolCallResult({ id: "c1", name: "read", arguments: { path: "a.txt" } }),
			textResult("a.txt 里写着「内容」"),
		]);

		const progress: string[] = [];
		const outcome = await subagentOf(fixture, 5).run("看看 a.txt", contextOf(fixture, (text) => progress.push(text)));

		assert.equal(outcome.stopReason, "done");
		assert.equal(outcome.steps, 2);
		assert.equal(outcome.report, "a.txt 里写着「内容」");
		assert.deepEqual(progress, ["第 1/5 步", "  调用 read", "第 2/5 步"]);
	});

	it("用满步数就停下，并把「没做完」写进汇报", async () => {
		workspace.writeFile("a.txt", "内容");
		const calls: LlmResult[] = Array.from({ length: 6 }, (_unused, index) =>
			toolCallResult({ id: `c${index}`, name: "read", arguments: { path: "a.txt" } }),
		);
		const fixture = fixtures(BASE_CONFIG, calls);

		const outcome = await subagentOf(fixture, 3).run("没完没了地读", contextOf(fixture));

		// 一次都不多问：步数上限就是模型调用次数
		assert.equal(fixture.client.requests.length, 3);
		assert.equal(outcome.stopReason, "steps");
		assert.equal(outcome.steps, 3);
		assert.match(outcome.report, /用满了 3 步上限/);
		assert.match(outcome.report, /还没有做完/);
	});

	it("模型出错时如实汇报，不假装做完", async () => {
		const fixture = fixtures(BASE_CONFIG, [errorResult("额度不足")]);
		const outcome = await subagentOf(fixture, 5).run("做事", contextOf(fixture));

		assert.equal(outcome.stopReason, "error");
		assert.equal(outcome.steps, 1);
		assert.match(outcome.report, /额度不足/);
		assert.match(outcome.report, /没有做完/);
	});

	it("参数拼不成 JSON 的工具调用不执行", async () => {
		const fixture = fixtures(BASE_CONFIG, [
			{
				content: [
					{ type: "toolCall", id: "c1", name: "write", arguments: {}, argumentsError: "工具参数不是合法 JSON" },
				],
				usage: undefined,
				stopReason: "toolUse",
				errorMessage: undefined,
				model: "test-model",
			},
			textResult("那我不写了"),
		]);

		const outcome = await subagentOf(fixture, 5).run("写个文件", contextOf(fixture));

		assert.equal(outcome.report, "那我不写了");
		// 拿空对象去执行等于替使用者猜了一个调用，文件必须没被创建
		assert.equal(existsSync(join(workspace.root, "x.txt")), false);
	});

	it("用量记进会话，并标明来自子代理", async () => {
		const fixture = fixtures(BASE_CONFIG, [
			{ ...textResult("做完了"), usage: { input: 30, output: 7, cacheRead: 0, cacheWrite: 0, total: 37 } },
		]);

		await subagentOf(fixture, 5).run("做事", contextOf(fixture));

		const usage = fixture.session.entries().filter((entry) => entry.type === "usage");
		assert.equal(usage.length, 1);
		assert.equal(usage[0].type === "usage" ? usage[0].kind : "", "subagent");
		assert.equal(usage[0].type === "usage" ? usage[0].usage.total : 0, 37);
	});
});

describe("子代理工具", () => {
	function driverOf(fixture: Fixture): TurnDriver {
		return new TurnDriver({
			provider: fixture.provider,
			model: fixture.model,
			config: fixture.config,
			client: fixture.client,
			tools: fixture.driverTools,
			session: fixture.session,
			workspace: fixture.workspace,
			sandbox: fixture.sandbox,
			onEvent: () => undefined,
		});
	}

	it("汇报作为工具结果回到主对话，子代理自己的对话不进主对话", async () => {
		workspace.writeFile("a.txt", "内容");
		const fixture = fixtures(BASE_CONFIG, [
			toolCallResult({ id: "c1", name: "subagent", arguments: { task: "看看 a.txt" } }),
			toolCallResult({ id: "c2", name: "read", arguments: { path: "a.txt" } }),
			textResult("子代理内部的结论"),
			textResult("我派它看过了"),
		]);

		await driverOf(fixture).run("看看文件", new AbortController().signal);

		const messages = fixture.session.state().messages;
		assert.equal(messages.length, 4);
		const result = messages[2];
		assert.equal(result.role, "toolResult");
		assert.equal(result.role === "toolResult" ? result.content : "", "子代理内部的结论");
		assert.equal(result.role === "toolResult" ? result.isError : true, false);

		// 子代理读到的原文只出现在工具结果里；它作为助手说过的话一条都没进主对话
		const said = messages
			.filter((message) => message.role === "assistant")
			.map((message) => (message.role === "assistant" ? assistantText(message) : ""));
		assert.deepEqual(said, ["我来查一下", "我派它看过了"]);
	});

	it("子代理拿不到子代理工具，因此不会再派子代理", async () => {
		workspace.writeFile("a.txt", "内容");
		const fixture = fixtures(BASE_CONFIG, [
			toolCallResult({ id: "c1", name: "subagent", arguments: { task: "看看 a.txt" } }),
			textResult("看完了"),
			textResult("好"),
		]);

		await driverOf(fixture).run("看看文件", new AbortController().signal);

		assert.ok(fixture.client.requests[0].tools.some((tool) => tool.name === "subagent"));
		assert.ok(!fixture.client.requests[1].tools.some((tool) => tool.name === "subagent"));
		assert.ok(fixture.client.requests[1].tools.some((tool) => tool.name === "read"));
	});

	it("子代理用满步数时工具结果是失败，原因写进内容", async () => {
		workspace.writeFile("a.txt", "内容");
		const fixture = fixtures(
			`${BASE_CONFIG}max_turns = 2\n`,
			[
				toolCallResult({ id: "c1", name: "subagent", arguments: { task: "没完没了" } }),
				toolCallResult({ id: "c2", name: "read", arguments: { path: "a.txt" } }),
				toolCallResult({ id: "c3", name: "read", arguments: { path: "a.txt" } }),
				textResult("好"),
			],
		);

		await driverOf(fixture).run("派个子代理", new AbortController().signal);

		assert.equal(fixture.client.requests.length, 4);
		const result = fixture.session.state().messages.find((message) => message.role === "toolResult");
		assert.equal(result?.role === "toolResult" ? result.toolName : "", "subagent");
		assert.equal(result?.role === "toolResult" ? result.isError : false, true);
		assert.match(result?.role === "toolResult" ? result.content : "", /用满了 2 步上限/);
	});

	it("根会话不受子代理步数上限约束", async () => {
		workspace.writeFile("a.txt", "内容");
		const fixture = fixtures(`${BASE_CONFIG}max_turns = 1\n`, [
			toolCallResult({ id: "c1", name: "read", arguments: { path: "a.txt" } }),
			toolCallResult({ id: "c2", name: "read", arguments: { path: "a.txt" } }),
			toolCallResult({ id: "c3", name: "read", arguments: { path: "a.txt" } }),
			textResult("读够了"),
		]);

		await driverOf(fixture).run("多读几次", new AbortController().signal);

		// max_turns 只管子代理：主对话连着调用三轮工具仍然照跑
		assert.equal(fixture.client.requests.length, 4);
		const kinds = fixture.session
			.entries()
			.flatMap((entry) => (entry.type === "usage" ? [entry.kind] : []));
		assert.deepEqual(kinds, ["turn"]);
	});

	it("名字被占用时拒绝再挂一个同名的", () => {
		const fixture = fixtures(BASE_CONFIG, []);
		assert.throws(() => fixture.driverTools.withExtraTool(createCoreTools()[0]), /已经被注册过了/);
	});
});
