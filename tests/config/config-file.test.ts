import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ConfigError } from "../../src/config/config-error.ts";
import { parseConfig } from "../../src/config/config-file.ts";

const FILE = "config.toml";

function expectError(source: string, messagePart: string, line?: number): ConfigError {
	try {
		parseConfig(source, FILE);
	} catch (error) {
		assert.ok(error instanceof ConfigError, `期望 ConfigError，实际是 ${String(error)}`);
		assert.ok(
			error.message.includes(messagePart),
			`期望错误信息包含「${messagePart}」，实际是「${error.message}」`,
		);
		if (line !== undefined) assert.equal(error.line, line);
		return error;
	}
	throw new Error("期望校验失败，但通过了");
}

describe("config.toml 必填项", () => {
	it("只写 provider 与 model 即可，其余取默认值", () => {
		const config = parseConfig('provider = "p"\nmodel = "m"\n', FILE);
		assert.equal(config.provider, "p");
		assert.equal(config.model, "m");
		assert.equal(config.reasoningEffort, "off");
		assert.equal(config.maxRetries, 10);
		assert.equal(config.approval, "ask");
		assert.equal(config.sandbox, "off");
		assert.equal(config.spillThreshold, 8192);
		assert.equal(config.ui.notify, "auto");
		assert.deepEqual(config.plugins, { disabled: [], trusted: [] });
		assert.deepEqual(config.mcpServers, []);
	});

	it("与模型相关的量留空，不代填", () => {
		const config = parseConfig('provider = "p"\nmodel = "m"\n', FILE);
		assert.equal(config.contextWindow, undefined);
		assert.equal(config.maxTokens, undefined);
		assert.equal(config.compactModel, undefined);
		assert.equal(config.reviewModel, undefined);
		assert.equal(config.maxTurns, undefined);
	});

	it("缺少 provider 或 model 时报错", () => {
		expectError('model = "m"\n', "缺少 provider");
		expectError('provider = "p"\n', "缺少 model");
	});
});

describe("config.toml 选项解析", () => {
	it("读全部顶层选项", () => {
		const config = parseConfig(
			[
				'provider = "p"',
				'model = "m"',
				'reasoning_effort = "high"',
				"context_window = 256000",
				"max_tokens = 8192",
				"max_retries = 3",
				'httpProxy = "http://127.0.0.1:7890"',
				'compact_model = "small"',
				'review_model = "judge"',
				'approval = "auto"',
				'sandbox = "workspace"',
				"max_turns = 20",
				"spill_threshold = 0",
				"",
			].join("\n"),
			FILE,
		);

		assert.equal(config.reasoningEffort, "high");
		assert.equal(config.contextWindow, 256000);
		assert.equal(config.maxTokens, 8192);
		assert.equal(config.maxRetries, 3);
		assert.equal(config.httpProxy, "http://127.0.0.1:7890");
		assert.equal(config.compactModel, "small");
		assert.equal(config.reviewModel, "judge");
		assert.equal(config.approval, "auto");
		assert.equal(config.sandbox, "workspace");
		assert.equal(config.maxTurns, 20);
		assert.equal(config.spillThreshold, 0);
	});

	it("显式空串的代理表示强制直连，与未设置区分开", () => {
		assert.equal(parseConfig('provider = "p"\nmodel = "m"\n', FILE).httpProxy, undefined);
		assert.equal(parseConfig('provider = "p"\nmodel = "m"\nhttpProxy = ""\n', FILE).httpProxy, "");
	});

	it("读 ui 与 plugins 两张表", () => {
		const config = parseConfig(
			[
				'provider = "p"',
				'model = "m"',
				"",
				"[ui]",
				'notify = "bell"',
				"",
				"[plugins]",
				'disabled = ["mcp-plugin"]',
				'trusted = ["E:\\\\Projects\\\\Reins"]',
				"",
			].join("\n"),
			FILE,
		);

		assert.equal(config.ui.notify, "bell");
		assert.deepEqual(config.plugins.disabled, ["mcp-plugin"]);
		assert.deepEqual(config.plugins.trusted, ["E:\\Projects\\Reins"]);
	});
});

describe("config.toml 严格校验", () => {
	it("拼错的顶层键报错并列出可用键", () => {
		const error = expectError('provider = "p"\nmodel = "m"\nmax_turn = 5\n', "无法识别的键 max_turn", 3);
		assert.ok(error.message.includes("max_turns"));
	});

	it("表内拼错的键同样报错", () => {
		expectError('provider = "p"\nmodel = "m"\n[ui]\nnotifiy = "off"\n', "无法识别的键 ui.notifiy");
	});

	it("类型不符时报错并指出位置", () => {
		expectError('provider = "p"\nmodel = "m"\nmax_retries = "3"\n', "应当是整数", 3);
		expectError("provider = 1\nmodel = \"m\"\n", "应当是字符串", 1);
		expectError('provider = "p"\nmodel = "m"\n[ui]\nnotify = 1\n', "只能是");
	});

	it("枚举取值非法时报错并列出候选", () => {
		const error = expectError('provider = "p"\nmodel = "m"\napproval = "always"\n', "只能是");
		assert.ok(error.message.includes("ask"));
		assert.ok(error.message.includes("yolo"));
		expectError('provider = "p"\nmodel = "m"\nsandbox = "strict"\n', "只能是");
		expectError('provider = "p"\nmodel = "m"\nreasoning_effort = "minimal"\n', "只能是");
	});

	it("数值越界时报错", () => {
		expectError('provider = "p"\nmodel = "m"\ncontext_window = 0\n', "不能小于 1");
		expectError('provider = "p"\nmodel = "m"\nmax_retries = -1\n', "不能小于 0");
		expectError('provider = "p"\nmodel = "m"\nspill_threshold = 1.5\n', "应当是整数");
	});

	it("把表写成普通值时给出可读的错误", () => {
		expectError('provider = "p"\nmodel = "m"\nui = 1\n', "应当是表");
	});
});

describe("config.toml 的 MCP server", () => {
	it("解析 stdio 型", () => {
		const config = parseConfig(
			[
				'provider = "p"',
				'model = "m"',
				"",
				"[mcp_servers.context7]",
				'command = "npx"',
				'args = ["-y", "@upstash/context7-mcp"]',
				"",
			].join("\n"),
			FILE,
		);

		assert.equal(config.mcpServers.length, 1);
		const server = config.mcpServers[0];
		assert.equal(server.name, "context7");
		assert.equal(server.type, "stdio");
		assert.equal(server.command, "npx");
		assert.deepEqual(server.args, ["-y", "@upstash/context7-mcp"]);
		assert.equal(server.disabled, false);
	});

	it("解析 http 型，含表头与调用超时", () => {
		const config = parseConfig(
			[
				'provider = "p"',
				'model = "m"',
				"",
				"[mcp_servers.docs]",
				'type = "http"',
				'url = "https://example.com/mcp"',
				'headers = { Authorization = "Bearer $DOCS_KEY" }',
				"call_timeout_ms = 120000",
				"disabled = true",
				"",
			].join("\n"),
			FILE,
		);

		const server = config.mcpServers[0];
		assert.equal(server.type, "http");
		assert.equal(server.url, "https://example.com/mcp");
		assert.deepEqual(server.headers, { Authorization: "Bearer $DOCS_KEY" });
		assert.equal(server.callTimeoutMs, 120000);
		assert.equal(server.disabled, true);
	});

	it("按有无 command 推断类型", () => {
		const stdio = parseConfig(
			'provider = "p"\nmodel = "m"\n[mcp_servers.a]\ncommand = "x"\n',
			FILE,
		);
		assert.equal(stdio.mcpServers[0].type, "stdio");

		const http = parseConfig(
			'provider = "p"\nmodel = "m"\n[mcp_servers.a]\nurl = "https://x"\n',
			FILE,
		);
		assert.equal(http.mcpServers[0].type, "http");
	});

	it("拒绝既无 command 也无 url，以及两者都写的情形", () => {
		expectError('provider = "p"\nmodel = "m"\n[mcp_servers.a]\ndisabled = true\n', "需要 command 或 url");
		expectError(
			'provider = "p"\nmodel = "m"\n[mcp_servers.a]\ncommand = "x"\nurl = "https://y"\n',
			"不能同时设置",
		);
	});

	it("拒绝类型与配置不符", () => {
		expectError(
			'provider = "p"\nmodel = "m"\n[mcp_servers.a]\ntype = "stdio"\nurl = "https://y"\n',
			"必须设置 command",
		);
		expectError(
			'provider = "p"\nmodel = "m"\n[mcp_servers.a]\ntype = "http"\ncommand = "x"\n',
			"必须设置 url",
		);
		expectError(
			'provider = "p"\nmodel = "m"\n[mcp_servers.a]\ntype = "websocket"\nurl = "https://y"\n',
			"只能是 stdio、http、sse 之一",
		);
	});
});

describe("仓库自带的 config.toml", () => {
	it("能通过校验", () => {
		const source = readFileSync(new URL("../../config.toml", import.meta.url), "utf8");
		const config = parseConfig(source, "config.toml");
		assert.ok(config.provider.length > 0);
		assert.ok(config.model.length > 0);
	});
});
