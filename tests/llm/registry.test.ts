import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBuiltinLlmRegistry, LlmRegistry, type LlmClientFactory } from "#src/llm/registry.ts";
import type { LlmClient, LlmEvent, LlmResult } from "#src/llm/client.ts";
import type { ModelEntry, ProviderEntry } from "#src/config/providers-file.ts";
import type { RetryPolicy } from "#src/llm/retry.ts";
import { EventStream } from "#src/llm/event-stream.ts";

const POLICY: RetryPolicy = { maxRetries: 1, baseDelayMs: 1 };

function provider(): ProviderEntry {
	return { id: "p", name: "p", baseUrl: "https://x", api: undefined, apiKey: "k", headers: {}, promptCacheKey: false, models: [] };
}

function model(api: string): ModelEntry {
	return { id: "m", name: "m", api, baseUrl: "https://x", reasoning: false, thinkingLevelMap: {}, input: ["text"], cost: undefined, contextWindow: undefined, maxTokens: undefined, maxTokensField: "max_tokens", headers: {} };
}

function idleClient(api: string): LlmClient {
	return {
		api,
		stream: () => {
			const stream = EventStream.incremental<LlmEvent, LlmResult>();
			stream.close({ stopReason: "stop", content: [], usage: undefined, errorMessage: undefined, model: "m" });
			return stream;
		},
	};
}

describe("适配器注册表", () => {
	it("内置注册表认三种协议", () => {
		const registry = createBuiltinLlmRegistry();
		assert.deepEqual([...registry.apis()].sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
	});

	it("重复注册同一协议报错", () => {
		const registry = new LlmRegistry();
		const factory: LlmClientFactory = { api: "x", create: () => idleClient("x") };
		registry.register(factory);
		assert.throws(() => registry.register(factory), /already has an adapter/);
	});

	it("未知协议报错并给出可用清单", () => {
		const registry = new LlmRegistry();
		assert.throws(() => registry.create(provider(), model("nope"), POLICY), /no adapter for protocol nope; available protocols: /);
	});

	it("create 按协议命中工厂", () => {
		const registry = new LlmRegistry();
		let created = 0;
		registry.register({
			api: "custom",
			create: () => {
				created += 1;
				return idleClient("custom");
			},
		});
		registry.create(provider(), model("custom"), POLICY);
		assert.equal(created, 1);
	});

	it("重复协议没机会被创建", () => {
		const registry = new LlmRegistry();
		registry.register({ api: "a", create: () => idleClient("a") });
		assert.throws(() => registry.register({ api: "a", create: () => idleClient("a") }), /already has an adapter/);
		const client = registry.create(provider(), model("a"), POLICY);
		assert.equal(client.api, "a");
	});

	it("内置注册表能为各自协议建客户端", () => {
		const registry = createBuiltinLlmRegistry();
		assert.equal(registry.create(provider(), model("anthropic-messages"), POLICY).api, "anthropic-messages");
		assert.equal(registry.create(provider(), model("openai-completions"), POLICY).api, "openai-completions");
		assert.equal(registry.create(provider(), model("openai-responses"), POLICY).api, "openai-responses");
	});
});
