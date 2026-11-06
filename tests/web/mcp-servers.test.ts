import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	mcpServerDraft,
	mcpServerTable,
	parseMcpServerInput,
	parseMcpServerName,
} from "#src/web/mcp-servers.ts";

describe("MCP server 表单校验", () => {
	it("接受 stdio 的命令、参数与环境变量", () => {
		const result = parseMcpServerInput({
			name: "filesystem",
			type: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "E:/work"],
			env: { DEBUG: "1" },
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.draft, {
			name: "filesystem",
			type: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "E:/work"],
			env: { DEBUG: "1" },
		});
		const draft = result.draft;
		assert.ok(draft);
		assert.deepEqual(mcpServerTable(draft), {
			type: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "E:/work"],
			env: { DEBUG: "1" },
		});
	});

	it("接受 http / sse 的地址与请求头", () => {
		for (const type of ["http", "sse"] as const) {
			const result = parseMcpServerInput({
				name: `docs-${type}`,
				type,
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer demo" },
			});
			assert.equal(result.ok, true);
			const draft = result.draft;
			assert.ok(draft);
			assert.deepEqual(mcpServerTable(draft), {
				type,
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer demo" },
			});
		}
	});

	it("拒绝缺命令、缺地址、非法名称与非法地址", () => {
		assert.equal(parseMcpServerInput({ name: "x", type: "stdio" }).ok, false);
		assert.equal(parseMcpServerInput({ name: "x", type: "http" }).ok, false);
		assert.equal(parseMcpServerInput({ name: "a/b", type: "http", url: "https://x" }).ok, false);
		assert.equal(parseMcpServerInput({ name: "x", type: "http", url: "file:///tmp/mcp" }).ok, false);
		assert.equal(parseMcpServerInput({ name: "x", type: "unknown", url: "https://x" }).ok, false);
	});

	it("拒绝非对象形式的请求头与环境变量", () => {
		assert.equal(
			parseMcpServerInput({ name: "x", type: "http", url: "https://x", headers: ["a=b"] }).ok,
			false,
		);
		assert.equal(
			parseMcpServerInput({ name: "x", type: "stdio", command: "node", env: { A: 1 } }).ok,
			false,
		);
	});
});

describe("MCP server 名称与详情", () => {
	it("只校验名称，供详情、删除与重连使用", () => {
		assert.deepEqual(parseMcpServerName(" docs "), { ok: true, name: "docs" });
		assert.equal(parseMcpServerName("").ok, false);
		assert.equal(parseMcpServerName("../x").ok, false);
		assert.equal(parseMcpServerName(undefined).ok, false);
	});

	it("把配置还原成表单形状", () => {
		assert.deepEqual(
			mcpServerDraft({
				name: "filesystem",
				type: "stdio",
				command: "npx",
				args: ["-y", "server"],
				url: undefined,
				headers: {},
				env: { DEBUG: "1" },
				timeoutSeconds: 30,
				disabled: false,
			}),
			{
				name: "filesystem",
				type: "stdio",
				command: "npx",
				args: ["-y", "server"],
				env: { DEBUG: "1" },
			},
		);
		assert.deepEqual(
			mcpServerDraft({
				name: "docs",
				type: "http",
				command: undefined,
				args: [],
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer demo" },
				env: {},
				timeoutSeconds: undefined,
				disabled: false,
			}),
			{
				name: "docs",
				type: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer demo" },
			},
		);
	});
});
