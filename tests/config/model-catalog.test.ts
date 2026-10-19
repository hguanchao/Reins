import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../../src/config/config-file.ts";
import { ModelCatalog } from "../../src/config/model-catalog.ts";
import { parseProviders } from "../../src/config/providers-file.ts";
import { resolveSelection } from "../../src/config/selection.ts";

const PROVIDERS = `{
	"providers": {
		"fengshao": {
			"baseUrl": "https://example.com/v1",
			"api": "openai-completions",
			"models": [
				{ "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash" },
				{ "id": "small", "name": "Small" }
			]
		},
		"openai": {
			"baseUrl": "https://api.openai.com/v1",
			"api": "openai-responses",
			"models": [{ "id": "gpt-5.2", "name": "GPT-5.2" }]
		}
	}
}`;

function catalogOf(extra = ""): ModelCatalog {
	const config = parseConfig(
		`provider = "fengshao"\nmodel = "deepseek-v4.1-flash"\n${extra}`,
		"config.toml",
	);
	const providers = parseProviders(PROVIDERS, "providers.json");
	const selection = resolveSelection(config, providers, "config.toml", "providers.json");
	return new ModelCatalog(providers, config, selection);
}

describe("会话内模型目录", () => {
	it("按声明顺序列出全部 provider 的模型，并标出当前模型", () => {
		const options = catalogOf().options();

		assert.deepEqual(
			options.map((item) => `${item.provider}/${item.model}:${item.current}`),
			[
				"fengshao/deepseek-v4.1-flash:true",
				"fengshao/small:false",
				"openai/gpt-5.2:false",
			],
		);
		assert.equal(options[0]?.name, "DeepSeek V4.1 Flash");
	});

	it("在同一 provider 内切换时保留可用的辅助模型", () => {
		const catalog = catalogOf('compact_model = "small"\nreview_model = "small"\n');

		const outcome = catalog.switchTo("fengshao", "small");

		assert.equal(outcome.warnings.length, 0);
		assert.equal(outcome.selection.model.id, "small");
		assert.equal(outcome.selection.compactModel?.id, "small");
		assert.equal(outcome.selection.reviewModel?.id, "small");
		assert.equal(catalog.selection?.model.id, "small");
	});

	it("跨 provider 切换时辅助模型不可用会回退到主模型并给出说明", () => {
		const catalog = catalogOf('compact_model = "small"\nreview_model = "small"\n');

		const outcome = catalog.switchTo("openai", "gpt-5.2");

		assert.equal(outcome.selection.model.id, "gpt-5.2");
		assert.equal(outcome.selection.compactModel, undefined);
		assert.equal(outcome.selection.reviewModel, undefined);
		assert.equal(outcome.warnings.length, 2);
		assert.match(outcome.warnings[0] ?? "", /compact_model "small".*openai/);
		assert.match(outcome.warnings[1] ?? "", /review_model "small".*openai/);
	});

	it("切换后列表的 current 标记跟着更新", () => {
		const catalog = catalogOf();

		catalog.switchTo("openai", "gpt-5.2");

		const current = catalog.options().filter((item) => item.current);
		assert.deepEqual(
			current.map((item) => `${item.provider}/${item.model}`),
			["openai/gpt-5.2"],
		);
	});

	it("没有当前选型时列表不标记 current，选中后才出现", () => {
		const config = parseConfig('provider = "openai"\nmodel = "gpt-5.2"\n', "config.toml");
		const providers = parseProviders(PROVIDERS, "providers.json");
		const catalog = new ModelCatalog(providers, config, undefined);

		assert.equal(catalog.selection, undefined);
		assert.ok(catalog.options().every((item) => !item.current));

		catalog.switchTo("fengshao", "deepseek-v4.1-flash");

		assert.deepEqual(
			catalog.options().filter((item) => item.current).map((item) => `${item.provider}/${item.model}`),
			["fengshao/deepseek-v4.1-flash"],
		);
	});

	it("未知 provider 或模型直接报错", () => {
		const catalog = catalogOf();

		assert.throws(() => catalog.switchTo("nope", "x"), /No provider nope/);
		assert.throws(() => catalog.switchTo("openai", "nope"), /No model nope under provider openai/);
	});
});
