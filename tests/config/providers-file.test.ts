import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../src/config/config-error.ts";
import { computeCost, parseProviders } from "../../src/config/providers-file.ts";

const FILE = "providers.json";

function expectError(source: string, messagePart: string, line?: number): ConfigError {
	try {
		parseProviders(source, FILE);
	} catch (error) {
		assert.ok(error instanceof ConfigError, `期望 ConfigError，实际是 ${String(error)}`);
		assert.ok(
			error.message.includes(messagePart),
			`期望错误信息包含「${messagePart}」，实际是「${error.message}」`,
		);
		if (line !== undefined) assert.equal(error.line, line);
		return error;
	}
	throw new Error("期望校验失败，但通过了");
}

describe("providers.json 解析", () => {
	it("读 provider 与模型，模型继承 provider 的 api 与 baseUrl", () => {
		const providersConfig = parseProviders(
			JSON.stringify({
				providers: {
					local: {
						name: "本地端点",
						baseUrl: "http://localhost:8000/v1",
						api: "openai-completions",
						apiKey: "not-needed",
						models: [{ id: "qwen2.5-coder:7b", contextWindow: 131072, maxTokens: 8192 }],
					},
				},
			}),
			FILE,
		);

		assert.equal(providersConfig.providers.length, 1);
		const provider = providersConfig.providers[0];
		assert.equal(provider.id, "local");
		assert.equal(provider.name, "本地端点");
		assert.equal(provider.apiKey, "not-needed");

		const model = provider.models[0];
		assert.equal(model.id, "qwen2.5-coder:7b");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, "http://localhost:8000/v1");
		assert.equal(model.contextWindow, 131072);
		assert.equal(model.maxTokens, 8192);
		assert.equal(model.reasoning, false);
		assert.deepEqual(model.thinkingLevelMap, {});
	});

	it("模型级设置覆盖 provider 级", () => {
		const providersConfig = parseProviders(
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://a",
						api: "openai-completions",
						models: [
							{ id: "one", baseUrl: "https://b", api: "anthropic-messages" },
							{ id: "two" },
						],
					},
				},
			}),
			FILE,
		);

		const provider = providersConfig.providers[0];
		assert.equal(provider.models[0].baseUrl, "https://b");
		assert.equal(provider.models[0].api, "anthropic-messages");
		assert.equal(provider.models[1].baseUrl, "https://a");
		assert.equal(provider.models[1].api, "openai-completions");
	});

	it("provider 未声明 name 时用 id 顶替显示名", () => {
		const providersConfig = parseProviders(
			JSON.stringify({
				providers: { p: { baseUrl: "https://x", api: "a", models: [{ id: "m" }] } },
			}),
			FILE,
		);
		assert.equal(providersConfig.providers[0].name, "p");
		assert.equal(providersConfig.providers[0].models[0].name, "m");
	});

	it("读思考等级映射，null 表示该等级不支持", () => {
		const providersConfig = parseProviders(
			JSON.stringify({
				providers: {
					p: {
						baseUrl: "https://x",
						api: "anthropic-messages",
						models: [
							{
								id: "m",
								reasoning: true,
								thinkingLevelMap: { low: "low", high: "high", xhigh: null },
							},
						],
					},
				},
			}),
			FILE,
		);

		const model = providersConfig.providers[0].models[0];
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.thinkingLevelMap, { low: "low", high: "high", xhigh: null });
	});

	it("允许注释", () => {
		const providersConfig = parseProviders(
			`{
				// 本地推理
				"providers": {
					"p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m" }] }
				}
			}`,
			FILE,
		);
		assert.equal(providersConfig.providers[0].id, "p");
	});

	it("没声明输入形态时按只收文本算：不替使用者猜它能看图", () => {
		const model = parseModel({ id: "m" });
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.cost, undefined);
	});

	it("声明输入形态", () => {
		assert.deepEqual(parseModel({ id: "m", input: ["text", "image"] }).input, ["text", "image"]);
		assert.deepEqual(parseModel({ id: "m", input: ["image"] }).input, ["image"]);
	});

	it("读单价，四项都要写", () => {
		const model = parseModel({
			id: "m",
			cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.3 },
		});
		assert.deepEqual(model.cost, { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.3 });
	});

	it("按单价算金额，没配单价时给 undefined 而不是 0", () => {
		const usage = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0, total: 3_500_000 };
		const cost = { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.3 };

		// 0.15 + 0.3 + 0.15 = 0.6
		assert.equal(computeCost(cost, usage), 0.6);
		// 0 会被读成「这次不要钱」，而事实是「不知道」
		assert.equal(computeCost(undefined, usage), undefined);
	});
});

/** 只关心模型级字段时用它，省得每个用例都写一遍 provider 外壳。 */
function parseModel(model: Record<string, unknown>) {
	return parseProviders(
		JSON.stringify({ providers: { p: { baseUrl: "https://x", api: "a", models: [model] } } }),
		FILE,
	).providers[0].models[0];
}

describe("providers.json 严格校验", () => {
	it("输入形态写错或写重复时报错", () => {
		expectError(
			'{ "providers": { "p": { "baseUrl": "x", "api": "a", "models": [{ "id": "m", "input": ["audio"] }] } } }',
			"元素只能是 text、image 之一",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "x", "api": "a", "models": [{ "id": "m", "input": [] }] } } }',
			"至少要声明一种输入形态",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "x", "api": "a", "models": [{ "id": "m", "input": ["text", "text"] }] } } }',
			"有重复的取值",
		);
	});

	it("单价只写一半时报错：半张单价表算出来的金额是错的", () => {
		expectError(
			'{ "providers": { "p": { "baseUrl": "x", "api": "a", "models": [{ "id": "m", "cost": { "input": 1 } }] } } }',
			"缺少 output、cacheRead、cacheWrite",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "x", "api": "a", "models": [{ "id": "m", "cost": { "input": -1, "output": 1, "cacheRead": 1, "cacheWrite": 1 } }] } } }',
			"不能小于 0",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "x", "api": "a", "models": [{ "id": "m", "cost": { "input": 1, "output": 1, "cacheRead": 1, "cacheWrite": 1, "tiers": [] } }] } } }',
			"无法识别的键",
		);
	});

	it("缺少 providers 或为空时报错", () => {
		expectError("{}", "缺少 providers");
		expectError('{ "providers": {} }', "至少要声明一个 provider");
	});

	it("provider 缺少 models 或为空时报错", () => {
		expectError('{ "providers": { "p": { "baseUrl": "https://x", "api": "a" } } }', "缺少 models");
		expectError('{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [] } } }', "至少要声明一个模型");
	});

	it("模型缺少 id 时报错", () => {
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{}] } } }',
			"缺少 id",
		);
	});

	it("api 与 baseUrl 两处都未声明时报错", () => {
		const error = expectError(
			'{ "providers": { "p": { "models": [{ "id": "m" }] } } }',
			"没有可用的 api",
		);
		assert.ok(error.line !== undefined);
		expectError(
			'{ "providers": { "p": { "api": "a", "models": [{ "id": "m" }] } } }',
			"没有可用的 baseUrl",
		);
	});

	it("同一 provider 下模型 id 重复时报错", () => {
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m" }, { "id": "m" }] } } }',
			"重复定义",
		);
	});

	it("拼错的键报错并列出可用键", () => {
		expectError('{ "provider": {} }', "无法识别的键 provider");
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "model": [] } } }',
			"无法识别的键 providers.p.model",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m", "context_window": 1 }] } } }',
			"无法识别的键 providers.p.models.0.context_window",
		);
	});

	it("类型不符时报错", () => {
		expectError(
			'{ "providers": { "p": { "baseUrl": 1, "api": "a", "models": [{ "id": "m" }] } } }',
			"应当是字符串",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m", "reasoning": "yes" }] } } }',
			"应当是布尔值",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m", "contextWindow": 0 }] } } }',
			"不能小于 1",
		);
	});

	it("思考等级映射的键与值都要合法", () => {
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m", "thinkingLevelMap": { "tiny": "x" } }] } } }',
			"只能是",
		);
		expectError(
			'{ "providers": { "p": { "baseUrl": "https://x", "api": "a", "models": [{ "id": "m", "thinkingLevelMap": { "high": 1 } }] } } }',
			"应当是字符串或 null",
		);
	});
});
