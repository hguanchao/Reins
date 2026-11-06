import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelEntry, ProviderEntry, ProvidersConfig } from "#src/config/providers-file.ts";
import { mergeProvider, providerViews, removeProvider } from "#src/web/providers.ts";

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
	return {
		id: "m1",
		name: "Model One",
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		thinkingLevelMap: {},
		input: ["text"],
		cost: undefined,
		contextWindow: 128_000,
		maxTokens: 8_192,
		maxTokensField: "max_tokens",
		headers: {},
		...overrides,
	};
}

function provider(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
	return {
		id: "p1",
		name: "Provider One",
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		apiKey: "secret-key",
		headers: {},
		promptCacheKey: false,
		enabled: true,
		models: [model()],
		...overrides,
	};
}

function config(providers: readonly ProviderEntry[] = [provider()]): ProvidersConfig {
	return { providers };
}

describe("提供方视图", () => {
	it("不回传 API Key，只标记是否已保存", () => {
		const views = providerViews(config());
		assert.equal(views[0]?.hasApiKey, true);
		assert.equal("apiKey" in (views[0] ?? {}), false);
		assert.equal(views[0]?.models[0]?.id, "m1");
		assert.equal(views[0]?.enabled, true);
	});
});

describe("提供方写回校验", () => {
	it("更新时保留原 API Key，并保留模型的高级字段", () => {
		const existing = provider({
			models: [model({ reasoning: true, maxTokensField: "max_completion_tokens" })],
		});
		const result = mergeProvider(
			config([existing]),
			{
				id: "p1",
				name: "Renamed Provider",
				models: [{ ...existing.models[0], name: "Renamed Model" }],
			},
			"/tmp/providers.json",
		);

		assert.equal(result.ok, true);
		const saved = result.config?.providers[0];
		assert.equal(saved?.name, "Renamed Provider");
		assert.equal(saved?.apiKey, "secret-key");
		assert.equal(saved?.models[0]?.name, "Renamed Model");
		assert.equal(saved?.models[0]?.maxTokensField, "max_completion_tokens");
	});

	it("允许先建没有模型的提供方，之后再补", () => {
		const result = mergeProvider(
			config(),
			{ id: "p2", name: "Provider Two", api: "openai-completions", baseUrl: "https://two.example.com", models: [] },
			"/tmp/providers.json",
		);
		assert.equal(result.ok, true);
		assert.deepEqual(result.config?.providers[1]?.models, []);
	});

	it("拒绝非法 ID 与未知字段", () => {
		assert.equal(
			mergeProvider(config(), { id: "../bad", models: [model()] }, "/tmp/providers.json").ok,
			false,
		);
		const unknown = mergeProvider(
			config(),
			{ id: "p2", name: "P2", models: [model()], unexpected: true },
			"/tmp/providers.json",
		);
		assert.equal(unknown.ok, false);
	});

	it("删除非当前提供方后仍保留其余项；只剩一个时拒绝", () => {
		const second = provider({ id: "p2", name: "Provider Two", models: [model({ id: "m2" })] });
		const removed = removeProvider(config([provider(), second]), "p2", "/tmp/providers.json");
		assert.equal(removed.ok, true);
		assert.deepEqual(removed.config?.providers.map((item) => item.id), ["p1"]);

		assert.equal(removeProvider(config(), "p1", "/tmp/providers.json").ok, false);
	});

	it("只改启用状态时保留密钥与模型", () => {
		const result = mergeProvider(config(), { id: "p1", enabled: false }, "/tmp/providers.json");
		assert.equal(result.ok, true);
		assert.equal(result.config?.providers[0]?.enabled, false);
		assert.equal(result.config?.providers[0]?.apiKey, "secret-key");
		assert.equal(result.config?.providers[0]?.models[0]?.id, "m1");
	});

	it("保存已有提供方时保持原有顺序", () => {
		const third = provider({ id: "p3", name: "Provider Three", models: [model({ id: "m3" })] });
		const result = mergeProvider(
			config([provider(), provider({ id: "p2", name: "Provider Two" }), third]),
			{ id: "p2", name: "Renamed" },
			"/tmp/providers.json",
		);
		assert.equal(result.ok, true);
		assert.deepEqual(result.config?.providers.map((item) => item.id), ["p1", "p2", "p3"]);
		assert.equal(result.config?.providers[1]?.name, "Renamed");
	});

	it("启用状态不是布尔值时拒绝", () => {
		const result = mergeProvider(config(), { id: "p1", enabled: "no" }, "/tmp/providers.json");
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /启用状态/);
	});
});
