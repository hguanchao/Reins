import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Config } from "#src/config/file.ts";
import type { ModelEntry, ProviderEntry } from "#src/config/providers-file.ts";
import { describeSettings, parseSettingsUpdate } from "#src/web/settings.ts";

/** 设置页的数据面：能力字段齐全，可写项严格校验。 */

const model: ModelEntry = {
	id: "m",
	name: "Model",
	api: "openai-completions",
	baseUrl: "https://example.com/v1",
	reasoning: true,
	thinkingLevelMap: { max: null },
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
	contextWindow: 128_000,
	maxTokens: 8_192,
	maxTokensField: "max_tokens",
	headers: {},
};

const provider: ProviderEntry = {
	id: "p",
	name: "Provider",
	baseUrl: "https://example.com/v1",
	api: "openai-completions",
	apiKey: "k",
	headers: {},
	promptCacheKey: false,
	models: [model],
};

const config: Config = {
	provider: "p",
	model: "m",
	reasoningEffort: "high",
	contextWindow: undefined,
	maxTokens: undefined,
	maxRetries: 10,
	streamIdleTimeout: 0,
	httpProxy: undefined,
	shellPath: undefined,
	compactModel: undefined,
	reviewModel: undefined,
	approval: "ask",
	sandbox: "off",
	maxTurns: undefined,
	spillThreshold: 8192,
	compaction: { compactAt: 0.8, keepRecent: 0.25, summaryTimeout: 0 },
	ui: { notify: "auto" },
	mcpServers: [],
	plugins: { disabled: [], trusted: [] },
};

describe("设置快照", () => {
	it("带上模型能力、思考等级与当前选择", () => {
		const snapshot = describeSettings({
			version: "1.0.0",
			configPath: "/config.toml",
			providersPath: "/providers.json",
			config,
			selection: { provider, model, compactModel: undefined, reviewModel: undefined },
			providers: [provider],
			mcpServers: [{ name: "demo", type: "stdio", disabled: false }],
			plugins: [{ name: "plugin", kind: "declarative", disabled: false }],
			skills: [{ name: "writer", description: "写文档", path: "/skills/writer/SKILL.md" }],
		});

		assert.equal(snapshot.provider, "p");
		assert.equal(snapshot.model, "m");
		assert.equal(snapshot.contextWindow, 128_000);
		assert.equal(snapshot.effort, "high");
		assert.deepEqual(snapshot.models[0]?.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);
		assert.deepEqual(snapshot.mcpServers[0], { name: "demo", type: "stdio", disabled: false });
		assert.equal(snapshot.skills[0]?.name, "writer");
	});
});

describe("设置更新校验", () => {
	it("接受可热更新的 effort 与 approval", () => {
		assert.deepEqual(parseSettingsUpdate({ effort: "max" }), { ok: true, update: { effort: "max" } });
		assert.deepEqual(parseSettingsUpdate({ approval: "yolo" }), { ok: true, update: { approval: "yolo" } });
	});

	it("非法取值、未知键与空更新都报错", () => {
		assert.equal(parseSettingsUpdate({ effort: "turbo" }).ok, false);
		assert.equal(parseSettingsUpdate({ approval: "never" }).ok, false);
		assert.equal(parseSettingsUpdate({ sandbox: "off" }).ok, false);
		assert.equal(parseSettingsUpdate({}).ok, false);
	});
});
