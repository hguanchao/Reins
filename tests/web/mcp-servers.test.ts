import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpServerTable, parseMcpServerInput } from "#src/web/mcp-servers.ts";

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
