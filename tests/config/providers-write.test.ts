import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseProviders, type ProvidersConfig } from "#src/config/providers-file.ts";
import { writeProviders } from "#src/config/providers-write.ts";

const directory = mkdtempSync(join(tmpdir(), "reins-providers-write-"));
after(() => rmSync(directory, { recursive: true, force: true }));

describe("providers.json 写回", () => {
	it("按名字为键写回，重新解析后字段与 API Key 保持", () => {
		const config: ProvidersConfig = {
			providers: [
				{
					id: "mock",
					name: "Mock",
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					apiKey: "secret",
					headers: { "X-Test": "1" },
					promptCacheKey: true,
					models: [
						{
							id: "m1",
							name: "Model One",
							api: "openai-completions",
							baseUrl: "https://api.example.com/v1",
							reasoning: true,
							thinkingLevelMap: { high: "high" },
							input: ["text"],
							cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
							contextWindow: 128_000,
							maxTokens: 8_192,
							maxTokensField: "max_tokens",
							headers: {},
						},
					],
				},
			],
		};
		const file = join(directory, "providers.json");

		writeProviders(config, file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /"mock":/);
		assert.doesNotMatch(text, /"id": "mock"/);
		const parsed = parseProviders(text, file);
		assert.equal(parsed.providers[0]?.apiKey, "secret");
		assert.equal(parsed.providers[0]?.models[0]?.thinkingLevelMap.high, "high");
		assert.deepEqual(parsed.providers[0]?.models[0]?.cost, {
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 0.2,
		});
	});
});
