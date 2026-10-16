import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../src/config/config-error.ts";
import { ConfigFile } from "../../src/config/config-file.ts";
import { mergeConfigs, mergeProviders } from "../../src/config/merge.ts";
import { parseProviders } from "../../src/config/providers-file.ts";

const USER = "user/config.toml";
const PROJECT = "project/config.toml";

function merge(userSource: string, projectSource: string): ReturnType<typeof mergeConfigs> {
	return mergeConfigs(
		ConfigFile.parse(userSource, USER),
		ConfigFile.parse(projectSource, PROJECT),
	);
}

describe("配置合并", () => {
	it("项目里写过某项时以项目为准", () => {
		const config = merge(
			'provider = "p"\nmodel = "m"\nmax_retries = 3\n',
			'provider = "p"\nmodel = "m"\nmax_retries = 7\n',
		);
		assert.equal(config.maxRetries, 7);
	});

	it("项目没写某项时保留用户的设置，而不是套用默认值", () => {
		// 只看最终值会把「项目没写」误当成「项目要求用默认值」，从而盖掉用户的设置
		const config = merge(
			'provider = "p"\nmodel = "m"\nmax_retries = 9\nspill_threshold = 4096\n',
			'provider = "p"\nmodel = "m"\n',
		);
		assert.equal(config.maxRetries, 9);
		assert.equal(config.spillThreshold, 4096);
	});

	it("项目可以改模型与界面设置", () => {
		const config = merge(
			'provider = "p"\nmodel = "m"\n\n[ui]\nnotify = "bell"\n',
			'provider = "p"\nmodel = "other"\n\n[ui]\nnotify = "off"\n',
		);
		assert.equal(config.model, "other");
		assert.equal(config.ui.notify, "off");
	});

	it("停用清单取并集：项目能多关一个，但不能把用户关掉的打开", () => {
		const config = merge(
			'provider = "p"\nmodel = "m"\n\n[plugins]\ndisabled = ["a-plugin"]\n',
			'provider = "p"\nmodel = "m"\n\n[plugins]\ndisabled = ["b-plugin"]\n',
		);
		assert.deepEqual([...config.plugins.disabled].sort(), ["a-plugin", "b-plugin"]);
	});

	it("信任清单只在用户级生效", () => {
		// 让项目声明自己可信，「不受信任的目录影响不了程序」这句话就不成立了
		const config = merge(
			'provider = "p"\nmodel = "m"\n\n[plugins]\ntrusted = ["/from-user"]\n',
			'provider = "p"\nmodel = "m"\n\n[plugins]\ntrusted = ["/from-project"]\n',
		);
		assert.deepEqual(config.plugins.trusted, ["/from-user"]);
	});

	it("MCP server 按名字合并，同名的以项目为准", () => {
		const config = merge(
			'provider = "p"\nmodel = "m"\n\n[mcp_servers.docs]\nurl = "https://user"\n\n[mcp_servers.keep]\nurl = "https://keep"\n',
			'provider = "p"\nmodel = "m"\n\n[mcp_servers.docs]\nurl = "https://project"\n',
		);
		assert.deepEqual(
			config.mcpServers.map((server) => [server.name, server.url]),
			[
				["docs", "https://project"],
				["keep", "https://keep"],
			],
		);
	});
});

describe("安全姿态只能加严", () => {
	it("项目可以把 approval 改得更严", () => {
		assert.equal(merge('provider = "p"\nmodel = "m"\napproval = "yolo"\n', 'provider = "p"\nmodel = "m"\napproval = "ask"\n').approval, "ask");
		assert.equal(merge('provider = "p"\nmodel = "m"\napproval = "auto"\n', 'provider = "p"\nmodel = "m"\napproval = "ask"\n').approval, "ask");
	});

	it("项目放宽 approval 会被拒绝，并指到具体位置", () => {
		assert.throws(
			() => merge('provider = "p"\nmodel = "m"\napproval = "ask"\n', 'provider = "p"\nmodel = "m"\napproval = "yolo"\n'),
			(error: unknown) => {
				assert.ok(error instanceof ConfigError);
				assert.match(error.message, /不能把 approval 从 ask 放宽到 yolo/);
				assert.equal(error.file, PROJECT);
				assert.equal(error.line, 3);
				return true;
			},
		);
	});

	it("项目可以把 sandbox 改得更严", () => {
		const config = merge(
			'provider = "p"\nmodel = "m"\nsandbox = "off"\n',
			'provider = "p"\nmodel = "m"\nsandbox = "read-only"\n',
		);
		assert.equal(config.sandbox, "read-only");
	});

	it("项目放宽 sandbox 会被拒绝", () => {
		assert.throws(
			() =>
				merge(
					'provider = "p"\nmodel = "m"\nsandbox = "read-only"\n',
					'provider = "p"\nmodel = "m"\nsandbox = "off"\n',
				),
			/不能把 sandbox 从 read-only 放宽到 off/,
		);
	});

	it("项目没写时不触发加严检查", () => {
		assert.equal(merge('provider = "p"\nmodel = "m"\napproval = "yolo"\n', 'provider = "p"\nmodel = "m"\n').approval, "yolo");
	});
});

describe("模型配置合并", () => {
	const user = parseProviders(
		JSON.stringify({
			providers: {
				a: { baseUrl: "https://a", api: "openai-completions", models: [{ id: "m1" }] },
				b: { baseUrl: "https://b", api: "openai-completions", models: [{ id: "m2" }] },
			},
		}),
		"user/providers.json",
	);
	const project = parseProviders(
		JSON.stringify({
			providers: {
				a: { baseUrl: "https://a-project", api: "openai-completions", models: [{ id: "m1" }] },
				c: { baseUrl: "https://c", api: "openai-completions", models: [{ id: "m3" }] },
			},
		}),
		"project/providers.json",
	);

	it("同名的整体替换，其余补上", () => {
		const merged = mergeProviders(user, project);
		assert.deepEqual(
			merged.providers.map((provider) => provider.id),
			["a", "b", "c"],
		);
		// 整体替换而不是逐字段合并：半新半旧的 provider 定义很难看出最终长什么样
		assert.equal(merged.providers[0].baseUrl, "https://a-project");
		assert.equal(merged.providers[1].baseUrl, "https://b");
	});
});
