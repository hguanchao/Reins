import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeCost, parseProviders } from "../../src/config/providers-file.ts";
import { resolveSelection } from "../../src/config/selection.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { ConfigError } from "../../src/config/config-error.ts";

const FULL = `{
	"providers": {
		"main": {
			"name": "Main",
			"baseUrl": "https://api.example.com/v1",
			"apiKey": "k-openai-0000",
			"api": "openai-completions",
			"models": [
				{ "id": "big", "name": "Big", "reasoning": true, "input": ["text", "image"] },
				{ "id": "small", "name": "Small" }
			]
		},
		"spare": {
			"name": "Spare",
			"baseUrl": "https://spare.example.com",
			"apiKey": "k-sp-0000",
			"api": "openai-completions",
			"models": [{ "id": "m", "name": "M" }]
		}
	}
}`;

function configOf(extra: string): ReturnType<typeof parseConfig> {
	return parseConfig(`provider = "main"\nmodel = "big"\n${extra}`, "config.toml");
}

function selection(extra: string) {
	return resolveSelection(configOf(extra), parseProviders(FULL, "providers.json"), "config.toml", "providers.json");
}

describe("providers.json 解析", () => {
	it("正常解析，provider 没给的字段由模型补，都没有才报错", () => {
		const providers = parseProviders(FULL, "providers.json");
		assert.equal(providers.providers.length, 2);
		const small = providers.providers[0]!.models[1]!;
		assert.equal(small.baseUrl, "https://api.example.com/v1");
		assert.equal(small.api, "openai-completions");
		assert.equal(small.reasoning, false);
		assert.deepEqual(small.input, ["text"]);
		assert.equal(small.cost, undefined);
	});

	it("模型里没有 id、api、baseUrl 报错", () => {
		const missingId = `{"providers": {"p": {"baseUrl": "b", "api": "a", "models": [{"name": "n"}]}}}`;
		assert.throws(() => parseProviders(missingId, "p"), /is missing id/);

		const noApi = `{"providers": {"p": {"models": [{"id": "m"}]}}}`;
		assert.throws(() => parseProviders(noApi, "p"), /no usable api/);

		const noUrl = `{"providers": {"p": {"api": "a", "models": [{"id": "m"}]}}}`;
		assert.throws(() => parseProviders(noUrl, "p"), /no usable baseUrl/);
	});

	it("同一 provider 里模型 id 重复报错", () => {
		const source = `{"providers": {"p": {"api": "a", "baseUrl": "b", "models": [{"id": "m"}, {"id": "m"}]}}}`;
		assert.throws(() => parseProviders(source, "p"), /Duplicate model m/);
	});

	it("空 providers 与空模型清单报错", () => {
		assert.throws(() => parseProviders(`{}`, "p"), /Missing providers/);
		assert.throws(() => parseProviders(`{"providers": {}}`, "p"), /at least one provider/);
		assert.throws(
			() => parseProviders(`{"providers": {"p": {"api": "a", "baseUrl": "b", "models": []}}}`, "p"),
			/at least one model/,
		);
	});

	it("单价表四项全写才合法", () => {
		const withCost = `{"providers": {"p": {"api": "a", "baseUrl": "b", "models": [{"id": "m", "cost": {"input": 1, "output": 2, "cacheRead": 0.5, "cacheWrite": 1.5}}]}}}`;
		const cost = parseProviders(withCost, "p").providers[0]!.models[0]!.cost;
		assert.deepEqual(cost, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 });

		const halfCost = `{"providers": {"p": {"api": "a", "baseUrl": "b", "models": [{"id": "m", "cost": {"input": 1}}]}}}`;
		assert.throws(() => parseProviders(halfCost, "p"), /missing/);
	});

	it("未知键报错并指明可选键", () => {
		assert.throws(() => parseProviders(`{"providers": {"p": {"api": "a", "baseUrl": "b", "wibble": 1, "models": [{"id": "m"}]}}}`, "p"), (error: unknown) => {
			assert.ok(error instanceof ConfigError);
			assert.match(error.display, /Unknown key providers\.p\.wibble.*valid keys/);
			return true;
		});
	});

	it("income 形态：重复或空清单报错，缺省按 text", () => {
		const dup = `{"providers": {"p": {"api": "a", "baseUrl": "b", "models": [{"id": "m", "input": ["text", "text"]}]}}}`;
		assert.throws(() => parseProviders(dup, "p"), /duplicate values/);
		const empty = `{"providers": {"p": {"api": "a", "baseUrl": "b", "models": [{"id": "m", "input": []}]}}}`;
		assert.throws(() => parseProviders(empty, "p"), /at least one input modality/);
	});
});

describe("按单价算金额", () => {
	it("四项合计除以一百万", () => {
		const cost = { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 1.5 };
		const usage = { input: 500, output: 200, cacheRead: 100, cacheWrite: 100, total: 900 };
		const amount = computeCost(cost, usage)!;
		assert.ok(Math.abs(amount - ((500 * 3 + 200 * 6 + 100 * 0.3 + 100 * 1.5) / 1_000_000)) < 1e-12);
	});

	it("没配单价返回 undefined", () => {
		assert.equal(computeCost(undefined, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }), undefined);
	});
});

describe("选型", () => {
	it("provider 与模型对应上", () => {
		const picked = selection("");
		assert.equal(picked.provider.id, "main");
		assert.equal(picked.model.id, "big");
		assert.equal(picked.compactModel, undefined);
		assert.equal(picked.reviewModel, undefined);
	});

	it("compact_model 与 review_model 落在同一个 provider 里", () => {
		const picked = selection(`compact_model = "small"\nreview_model = "small"\n`);
		assert.equal(picked.compactModel?.id, "small");
		assert.equal(picked.reviewModel?.id, "small");
	});

	it("provider 名字写错时把可选项列出来", () => {
		const config = parseConfig(`provider = "nope"\nmodel = "big"\n`, "c");
		assert.throws(
			() => resolveSelection(config, parseProviders(FULL, "providers.json"), "c", "p"),
			(error: unknown) => {
				assert.ok(error instanceof ConfigError);
				assert.match(error.message, /No provider nope.*available: main, spare/);
				return true;
			},
		);
	});

	it("模型名字写错时列出 thisProvider 的可选模型", () => {
		const config = parseConfig(`provider = "main"\nmodel = "nope"\n`, "c");
		assert.throws(
			() => resolveSelection(config, parseProviders(FULL, "providers.json"), "c", "p"),
			(error: unknown) => {
				assert.ok(error instanceof ConfigError);
				assert.match(error.message, /No model nope under provider main.*available: big, small/);
				return true;
			},
		);
	});

	it("专用模型不在 provider 里时指明 key", () => {
		assert.throws(() => selection(`compact_model = "m"\n`), /Model m set by compact_model is not in provider main/);
	});
});
