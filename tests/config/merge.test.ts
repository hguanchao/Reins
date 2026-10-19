import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigFile, parseConfig } from "../../src/config/config-file.ts";
import { mergeConfigs, mergeProviders } from "../../src/config/merge.ts";
import { ConfigError } from "../../src/config/config-error.ts";
import type { ProvidersConfig } from "../../src/config/providers-file.ts";

const BASE = `provider = "a"\nmodel = "m1"\n`;

function get(source: string): ConfigFile {
	return ConfigFile.parse(source, "config.toml");
}

describe("配置合并", () => {
	it("普通的项由项目覆盖用户", () => {
		const merged = mergeConfigs(get(`${BASE}compact_model = "m9"\n`), get(`${BASE}compact_model = "m8"\n`));
		assert.equal(merged.compactModel, "m8");
		assert.equal(merged.provider, "a");
	});

	it("项目没写的项沿用用户的", () => {
		const merged = mergeConfigs(get(`${BASE}max_retries = 3\n`), get(BASE));
		assert.equal(merged.maxRetries, 3);
	});

	it("审批只准加严:放宽报错", () => {
		// 用户要求逐次询问（最严），项目想切成 yolo（最松），等于放宽：拒绝
		const user = get(`${BASE}approval = "ask"\n`);
		const project = get(`${BASE}approval = "yolo"\n`);
		assert.throws(() => mergeConfigs(user, project), (error: unknown) => {
			assert.ok(error instanceof ConfigError);
			assert.match(error.message, /cannot relax approval/);
			return true;
		});
	});

	it("审批可以加严", () => {
		const merged = mergeConfigs(get(`${BASE}approval = "yolo"\n`), get(`${BASE}approval = "ask"\n`));
		assert.equal(merged.approval, "ask");
	});

	it("沙箱同样只准加严", () => {
		assert.throws(
			() => mergeConfigs(get(`${BASE}sandbox = "read-only"\n`), get(`${BASE}sandbox = "workspace"\n`)),
			/cannot relax sandbox/,
		);
		const merged = mergeConfigs(get(`${BASE}sandbox = "read-only"\n`), get(`${BASE}sandbox = "read-only"\n`));
		assert.equal(merged.sandbox, "read-only");
	});

	it("插件停用清单取并集，信任清单不变", () => {
		const merged = mergeConfigs(
			get(`${BASE}[plugins]\ndisabled = ["a"]\n`),
			get(`${BASE}[plugins]\ndisabled = ["b"]\n`),
		);
		assert.deepEqual(merged.plugins.disabled, ["a", "b"]);
	});

	it("去重停用清单", () => {
		const merged = mergeConfigs(
			get(`${BASE}[plugins]\ndisabled = ["a"]\n`),
			get(`${BASE}[plugins]\ndisabled = ["a"]\n`),
		);
		assert.deepEqual(merged.plugins.disabled, ["a"]);
	});

	it("MCP server:同名以项目为准，其余补上", () => {
		const user = get(`${BASE}[mcp_servers.fs]\ncommand = "old"\n[mcp_servers.old]\ncommand = "keep"\n`);
		const project = get(`${BASE}[mcp_servers.fs]\ncommand = "new"\n[mcp_servers.added]\nurl = "http://x"\n`);
		const merged = mergeConfigs(user, project);
		assert.deepEqual(
			merged.mcpServers.map((server) => `${server.name}:${server.url ?? server.command}`),
			["fs:new", "old:keep", "added:http://x"],
		);
	});

	it("providers 合并:同名整体替换，其余补上", () => {
		const user: ProvidersConfig = {
			providers: [
				{ id: "a", name: "a", baseUrl: "ua", api: "openai-completions", apiKey: undefined, headers: {}, promptCacheKey: false, models: [] },
				{ id: "b", name: "b", baseUrl: "ub", api: "openai-completions", apiKey: undefined, headers: {}, promptCacheKey: false, models: [] },
			],
		};
		const project: ProvidersConfig = {
			providers: [
				{ id: "a", name: "a", baseUrl: "pa", api: "openai-completions", apiKey: undefined, headers: {}, promptCacheKey: false, models: [] },
				{ id: "c", name: "c", baseUrl: "pc", api: "openai-completions", apiKey: undefined, headers: {}, promptCacheKey: false, models: [] },
			],
		};
		const merged = mergeProviders(user, project);
		assert.deepEqual(
			merged.providers.map((provider) => `${provider.id}:${provider.baseUrl}`),
			["a:pa", "b:ub", "c:pc"],
		);
	});

	it("parseConfig 校验缺 provider 或 model 时报错", () => {
		assert.throws(() => parseConfig(`model = "m"\n`, "c"), /Missing provider/);
		assert.throws(() => parseConfig(`provider = "p"\n`, "c"), /Missing model/);
	});

	it("parseConfig 拒绝未知键并给出可选键", () => {
		assert.throws(() => parseConfig(`provider = "p"\nmodel = "m"\nnope = 1\n`, "c"), (error: unknown) => {
			assert.ok(error instanceof ConfigError);
			assert.match(error.display, /^c:\d+:\d+ Unknown key nope/);
			return true;
		});
	});

	it("默认值各就各位", () => {
		const config = parseConfig(`provider = "p"\nmodel = "m"\n`, "c");
		assert.equal(config.reasoningEffort, "off");
		assert.equal(config.approval, "ask");
		assert.equal(config.sandbox, "off");
		assert.equal(config.maxRetries, 10);
		assert.equal(config.spillThreshold, 8192);
		assert.equal(config.ui.notify, "auto");
	});
});
