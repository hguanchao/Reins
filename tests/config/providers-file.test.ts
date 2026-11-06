import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseProviders } from "#src/config/providers-file.ts";

/** 只关心模型条目本身的用例：provider 层的必填项照最小形状填上。 */
function providersWith(model: string): string {
	return `{
		"providers": {
			"p": {
				"baseUrl": "https://example.com/v1",
				"api": "openai-completions",
				"apiKey": "k",
				"models": [${model}]
			}
		}
	}`;
}

function firstModel(model: string): ReturnType<typeof parseProviders>["providers"][number]["models"][number] | undefined {
	return parseProviders(providersWith(model), "providers.json").providers[0]?.models[0];
}

function firstProvider(extra: string): ReturnType<typeof parseProviders>["providers"][number] | undefined {
	const source = `{
		"providers": {
			"p": {
				"baseUrl": "https://example.com/v1",
				"api": "openai-completions",
				"apiKey": "k",
				${extra}
				"models": [{ "id": "m" }]
			}
		}
	}`;
	return parseProviders(source, "providers.json").providers[0];
}

describe("模型条目的解析", () => {
	it("maxTokensField 缺省用 max_tokens", () => {
		assert.equal(firstModel('{ "id": "m" }')?.maxTokensField, "max_tokens");
	});

	it("声明为 max_completion_tokens 时照收", () => {
		const model = firstModel('{ "id": "m", "maxTokensField": "max_completion_tokens" }');

		assert.equal(model?.maxTokensField, "max_completion_tokens");
	});

	it("maxTokensField 写了别的值直接报错", () => {
		assert.throws(
			() => parseProviders(providersWith('{ "id": "m", "maxTokensField": "max_output_tokens" }'), "providers.json"),
			/must be max_tokens or max_completion_tokens/,
		);
	});

	it("promptCacheKey 缺省关闭", () => {
		assert.equal(firstProvider("")?.promptCacheKey, false);
	});

	it("promptCacheKey 显式开启时照收", () => {
		assert.equal(firstProvider('"promptCacheKey": true,')?.promptCacheKey, true);
	});

	it("promptCacheKey 不是布尔值时报错", () => {
		assert.throws(
			() => firstProvider('"promptCacheKey": "yes",'),
			/must be a boolean/,
		);
	});
});

describe("模型列表", () => {
	it("允许为空数组", () => {
		const provider = parseProviders(
			`{ "providers": { "p": { "baseUrl": "https://e.com/v1", "api": "openai-completions", "models": [] } } }`,
			"providers.json",
		).providers[0];
		assert.deepEqual(provider?.models, []);
	});
});

describe("提供方启用状态", () => {
	it("缺省视为启用", () => {
		assert.equal(firstProvider("")?.enabled, true);
	});

	it("显式关闭时读成 false", () => {
		assert.equal(firstProvider('"enabled": false,')?.enabled, false);
	});

	it("不是布尔值时报错", () => {
		assert.throws(() => firstProvider('"enabled": "no",'), /must be a boolean/);
	});
});
