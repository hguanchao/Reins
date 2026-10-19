import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadSelection } from "../../src/cli/bootstrap.ts";
import type { CliOptions } from "../../src/cli/args.ts";

const directory = mkdtempSync(join(tmpdir(), "reins-bootstrap-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const PROVIDERS = JSON.stringify({
	providers: {
		fengshao: {
			baseUrl: "https://example.com/v1",
			api: "openai-completions",
			apiKey: "$EXAMPLE_API_KEY",
			models: [{ id: "deepseek-v4.1-flash" }],
		},
	},
});

function options(configPath: string, providersPath: string): CliOptions {
	return {
		command: "tui",
		prompt: "",
		configPath,
		providersPath,
		trust: undefined,
		resume: undefined,
	};
}

function write(name: string, content: string): string {
	const path = join(directory, name);
	writeFileSync(path, content);
	return path;
}

describe("启动选型", () => {
	it("配置正确时返回选中的 provider 与模型", async () => {
		const config = write("ok.toml", 'provider = "fengshao"\nmodel = "deepseek-v4.1-flash"\n');
		const providers = write("ok.json", PROVIDERS);

		const result = await loadSelection(options(config, providers));

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.selection.provider.id, "fengshao");
		assert.equal(result.value.selection.model.id, "deepseek-v4.1-flash");
	});

	it("provider 对不上时返回可恢复错误，交给界面用 /model 修复", async () => {
		const config = write("mismatch.toml", 'provider = "openai"\nmodel = "gpt-5.2"\n');
		const providers = write("mismatch.json", PROVIDERS);

		const result = await loadSelection(options(config, providers));

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.recoverable, true);
		assert.match(result.error.display, /No provider openai/);
		assert.match(result.error.display, /available: fengshao/);
		assert.equal(result.config.provider, "openai");
		assert.ok(result.providersConfig.providers.some((provider) => provider.id === "fengshao"));
	});

	it("配置文件本身读不出来时不进入可恢复状态", async () => {
		const config = write("broken.toml", 'provider = "openai"\n');
		const providers = write("broken.json", PROVIDERS);

		const result = await loadSelection(options(config, providers));

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.recoverable, false);
		assert.match(result.error.message, /Missing model/);
	});
});
