import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../src/config/config-error.ts";
import { parseConfig } from "../../src/config/config-file.ts";
import { parseModels } from "../../src/config/models-file.ts";
import { resolveSelection } from "../../src/config/selection.ts";

const CONFIG_FILE = "config.toml";
const MODELS_FILE = "models.json";

const MODELS_SOURCE = JSON.stringify({
	providers: {
		local: {
			baseUrl: "http://localhost:8000/v1",
			api: "openai-completions",
			models: [{ id: "big" }, { id: "small" }, { id: "judge" }],
		},
		remote: {
			baseUrl: "https://api.example.com",
			api: "anthropic-messages",
			models: [{ id: "big" }],
		},
	},
});

function resolve(configSource: string): ReturnType<typeof resolveSelection> {
	return resolveSelection(
		parseConfig(configSource, CONFIG_FILE),
		parseModels(MODELS_SOURCE, MODELS_FILE),
		CONFIG_FILE,
		MODELS_FILE,
	);
}

describe("provider 与模型的对应", () => {
	it("把两份配置对应起来", () => {
		const selection = resolve('provider = "remote"\nmodel = "big"\n');
		assert.equal(selection.provider.id, "remote");
		assert.equal(selection.model.api, "anthropic-messages");
		assert.equal(selection.compactModel, undefined);
		assert.equal(selection.reviewModel, undefined);
	});

	it("同名模型在不同 provider 下互不影响", () => {
		const local = resolve('provider = "local"\nmodel = "big"\n');
		assert.equal(local.model.baseUrl, "http://localhost:8000/v1");
	});

	it("对应不到 provider 时报错并列出可选项", () => {
		try {
			resolve('provider = "nope"\nmodel = "big"\n');
			assert.fail("期望报错");
		} catch (error) {
			assert.ok(error instanceof ConfigError);
			assert.ok(error.message.includes("没有 provider nope"));
			assert.ok(error.message.includes("local"));
			assert.ok(error.message.includes("remote"));
		}
	});

	it("对应不到模型时报错并列出该 provider 的模型", () => {
		try {
			resolve('provider = "local"\nmodel = "nope"\n');
			assert.fail("期望报错");
		} catch (error) {
			assert.ok(error instanceof ConfigError);
			assert.ok(error.message.includes("没有模型 nope"));
			assert.ok(error.message.includes("big、small、judge"));
		}
	});

	it("压缩与审查模型必须落在同一个 provider 内", () => {
		const selection = resolve(
			'provider = "local"\nmodel = "big"\ncompact_model = "small"\nreview_model = "judge"\n',
		);
		assert.equal(selection.compactModel?.id, "small");
		assert.equal(selection.reviewModel?.id, "judge");

		try {
			resolve('provider = "remote"\nmodel = "big"\ncompact_model = "small"\n');
			assert.fail("期望报错");
		} catch (error) {
			assert.ok(error instanceof ConfigError);
			assert.ok(error.message.includes("compact_model 指定的模型 small 不在 provider remote 内"));
		}
	});
});
