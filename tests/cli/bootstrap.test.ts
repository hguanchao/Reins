import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadSelection, main } from "../../src/cli/bootstrap.ts";
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

describe("启动全屏界面", () => {
	it("起不来界面时不补配置模板，也不留下文件", async () => {
		// 测试进程的输入输出不是终端，正是「进不了界面」的情形
		const home = mkdtempSync(join(tmpdir(), "reins-tui-"));
		const previousHome = process.env["REINS_HOME"];
		const previousWrite = process.stderr.write.bind(process.stderr);
		let stderr = "";
		process.env["REINS_HOME"] = home;
		process.stderr.write = ((chunk: string) => {
			stderr += chunk;
			return true;
		}) as typeof process.stderr.write;

		try {
			// 不带参数才是全屏界面；带上位置参数会走一次性提问
			assert.equal(await main([]), 1);
		} finally {
			process.stderr.write = previousWrite;
			if (previousHome === undefined) delete process.env["REINS_HOME"];
			else process.env["REINS_HOME"] = previousHome;
		}

		try {
			assert.match(stderr, /needs an interactive terminal/);
			assert.equal(existsSync(join(home, "config.toml")), false);
			assert.equal(existsSync(join(home, "providers.json")), false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
