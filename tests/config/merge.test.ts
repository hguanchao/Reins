import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigFile, parseConfig } from "#src/config/file.ts";
import { mergeConfigs, mergeProviders } from "#src/config/merge.ts";
import { ConfigError } from "#src/config/error.ts";
import type { ProvidersConfig } from "#src/config/providers-file.ts";

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

	it("shellPath 与 shell_path 都支持，冲突时报错", () => {
		const camel = parseConfig(`${BASE}shellPath = "C:/camel/bash.exe"\n`, "c");
		assert.equal(camel.shellPath, "C:/camel/bash.exe");

		const snake = parseConfig(`${BASE}shell_path = "C:/snake/bash.exe"\n`, "c");
		assert.equal(snake.shellPath, "C:/snake/bash.exe");

		const same = parseConfig(
			`${BASE}shellPath = "C:/same/bash.exe"\nshell_path = "C:/same/bash.exe"\n`,
			"c",
		);
		assert.equal(same.shellPath, "C:/same/bash.exe");

		assert.throws(
			() => parseConfig(`${BASE}shellPath = "C:/a"\nshell_path = "C:/b"\n`, "c"),
			/must match/,
		);
		assert.equal(parseConfig(`${BASE}shellPath = ""\n`, "c").shellPath, undefined);
	});

	it("shellPath 只在用户级生效，项目写的被忽略", () => {
		// 它决定 bash 工具用哪个二进制：项目配置能改它，等于让一个目录指定要运行的程序
		const merged = mergeConfigs(
			get(`${BASE}shell_path = "C:/user/bash.exe"\n`),
			get(`${BASE}shellPath = "C:/project/bash.exe"\n`),
		);
		assert.equal(merged.shellPath, "C:/user/bash.exe");

		const inherited = mergeConfigs(get(`${BASE}shell_path = "C:/user/bash.exe"\n`), get(BASE));
		assert.equal(inherited.shellPath, "C:/user/bash.exe");

		const none = mergeConfigs(get(BASE), get(`${BASE}shellPath = "C:/project/bash.exe"\n`));
		assert.equal(none.shellPath, undefined);
	});

	it("所有多词配置项都支持 camelCase 与 snake_case", () => {
		const config = parseConfig(
			`provider = "p"
model = "m"
reasoningEffort = "high"
contextWindow = 2000
maxTokens = 100
maxRetries = 3
http_proxy = "http://proxy"
shell_path = "C:/bash.exe"
compactModel = "cm"
reviewModel = "rm"
maxTurns = 5
spillThreshold = 10
streamIdleTimeout = 30

[mcpServers.fs]
command = "x"
timeout = 120
`,
			"c",
		);

		assert.equal(config.reasoningEffort, "high");
		assert.equal(config.contextWindow, 2000);
		assert.equal(config.maxTokens, 100);
		assert.equal(config.maxRetries, 3);
		assert.equal(config.httpProxy, "http://proxy");
		assert.equal(config.shellPath, "C:/bash.exe");
		assert.equal(config.compactModel, "cm");
		assert.equal(config.reviewModel, "rm");
		assert.equal(config.maxTurns, 5);
		assert.equal(config.spillThreshold, 10);
		assert.equal(config.streamIdleTimeout, 30);
		assert.equal(config.mcpServers[0]?.name, "fs");
		assert.equal(config.mcpServers[0]?.timeoutSeconds, 120);
	});

	it("shellPath 支持转义反斜杠与 TOML 字面量字符串", () => {
		const expected = "D:\\Environment\\Git\\bin\\bash.exe";
		const escaped = parseConfig(
			`${BASE}shellPath = "D:\\\\Environment\\\\Git\\\\bin\\\\bash.exe"\n`,
			"c",
		);
		const literal = parseConfig(
			`${BASE}shellPath = 'D:\\Environment\\Git\\bin\\bash.exe'\n`,
			"c",
		);

		assert.equal(escaped.shellPath, expected);
		assert.equal(literal.shellPath, expected);
	});

	it("同一项两种写法冲突时报错", () => {
		assert.throws(
			() => parseConfig(`${BASE}context_window = 1\ncontextWindow = 2\n`, "c"),
			/must match/,
		);
		assert.throws(
			() =>
				parseConfig(
					`${BASE}[mcp_servers.a]\ncommand = "x"\n[mcpServers.b]\ncommand = "y"\n`,
					"c",
				),
			/only one of mcp_servers and mcpServers/,
		);
	});

	it("项目用 camelCase 写也能覆盖用户的 snake_case", () => {
		const merged = mergeConfigs(
			get(`${BASE}context_window = 100\n`),
			get(`${BASE}contextWindow = 200\n`),
		);
		assert.equal(merged.contextWindow, 200);
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

	it("MCP server 的 env 与 headers 各自独立读出来", () => {
		const parsed = get(
			`${BASE}[mcp_servers.fs]\ncommand = "npx"\n[mcp_servers.fs.env]\nTOKEN = "abc"\n[mcp_servers.fs.headers]\nX-Trace = "1"\n`,
		);
		const server = parsed.config.mcpServers[0];
		assert.deepEqual(server?.env, { TOKEN: "abc" });
		assert.deepEqual(server?.headers, { "X-Trace": "1" });
	});

	it("MCP server 只在用户级生效，项目既不能覆盖也不能新增", () => {		// 这些是本程序启动的本地进程：项目配置能声明它们，等于让一个目录决定启动什么程序
		const user = get(`${BASE}[mcp_servers.fs]\ncommand = "old"\n[mcp_servers.old]\ncommand = "keep"\n`);
		const project = get(`${BASE}[mcp_servers.fs]\ncommand = "new"\n[mcp_servers.added]\nurl = "http://x"\n`);
		const merged = mergeConfigs(user, project);
		assert.deepEqual(
			merged.mcpServers.map((server) => `${server.name}:${server.url ?? server.command}`),
			["fs:old", "old:keep"],
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

	it("[compaction] 的默认值、别名与范围校验", () => {
		const defaults = parseConfig(`provider = "p"\nmodel = "m"\n`, "c");
		assert.equal(defaults.compaction.compactAt, 0.8);
		assert.equal(defaults.compaction.keepRecent, 0.25);
		assert.equal(defaults.compaction.summaryTimeout, 0);

		const custom = parseConfig(
			`provider = "p"
model = "m"

[compaction]
compactAt = 0.6
keep_recent = 0.1
summary_timeout = 30
`,
			"c",
		);
		assert.equal(custom.compaction.compactAt, 0.6);
		assert.equal(custom.compaction.keepRecent, 0.1);
		assert.equal(custom.compaction.summaryTimeout, 30);

		assert.throws(
			() => parseConfig(`provider = "p"\nmodel = "m"\n\n[compaction]\ncompact_at = 1.5\n`, "c"),
			/compaction\.compact_at must be at most 1/,
		);
		assert.throws(
			() => parseConfig(`provider = "p"\nmodel = "m"\n\n[compaction]\ncompact_at = 0\n`, "c"),
			/compaction\.compact_at must be greater than 0/,
		);
		assert.throws(
			() => parseConfig(`provider = "p"\nmodel = "m"\n\n[compaction]\nkeep_recent = 2\n`, "c"),
			/compaction\.keep_recent must be at most 1/,
		);
	});

	it("默认值各就各位", () => {
		const config = parseConfig(`provider = "p"\nmodel = "m"\n`, "c");
		assert.equal(config.reasoningEffort, "off");
		assert.equal(config.approval, "ask");
		assert.equal(config.sandbox, "off");
		assert.equal(config.maxRetries, 10);
		assert.equal(config.spillThreshold, 8192);
		// 静默超时默认不限：替使用者判定「这么久没动静就是断线」会把正常的长请求判死
		assert.equal(config.streamIdleTimeout, 0);
		assert.equal(config.ui.notify, "auto");
	});

	it("静默超时只接受非负整数", () => {
		const config = parseConfig(`provider = "p"\nmodel = "m"\nstream_idle_timeout = 0\n`, "c");
		assert.equal(config.streamIdleTimeout, 0);

		assert.throws(
			() => parseConfig(`provider = "p"\nmodel = "m"\nstream_idle_timeout = -1\n`, "c"),
			/stream_idle_timeout must be at least 0/,
		);
	});
});
