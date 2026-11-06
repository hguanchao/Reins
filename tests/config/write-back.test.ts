import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseConfig } from "#src/config/file.ts";
import {
	appendMcpServerSection,
	removeMcpServerSection,
	updateMcpServerSection,
	updateModelSelection,
	updateUserConfigValue,
} from "#src/config/write-back.ts";

const directory = mkdtempSync(join(tmpdir(), "reins-write-back-"));
after(() => rmSync(directory, { recursive: true, force: true }));

describe("写回模型选择", () => {
	it("一次写入 provider 与 model，保留注释和其它键", () => {
		const file = join(directory, "config.toml");
		writeFileSync(
			file,
			'# 保留这行注释\nprovider = "old"\nmodel = "old-model"\nreasoning_effort = "medium"\n',
			"utf8",
		);

		updateModelSelection("fengshao", "deepseek-v4.1-flash", file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /# 保留这行注释/);
		assert.match(text, /provider = "fengshao"/);
		assert.match(text, /model = "deepseek-v4.1-flash"/);
		assert.match(text, /reasoning_effort = "medium"/);
	});

	it("文件不存在时创建并写入", () => {
		const file = join(directory, "nested", "new.toml");

		updateModelSelection("openai", "gpt-5.2", file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /provider = "openai"/);
		assert.match(text, /model = "gpt-5.2"/);
	});

	it("写回 reasoning_effort 时保留其它键与注释", () => {
		const file = join(directory, "effort.toml");
		writeFileSync(
			file,
			'provider = "p"\nmodel = "m"\nreasoning_effort = "low"\n# keep\n',
			"utf8",
		);

		updateUserConfigValue(["reasoning_effort"], () => "high", file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /reasoning_effort = "high"/);
		assert.match(text, /provider = "p"/);
		assert.match(text, /# keep/);
	});

	it("配置里写的是 camelCase 时改原键，而不是再补一条 snake_case", () => {
		const file = join(directory, "camel.toml");
		writeFileSync(file, 'provider = "p"\nmodel = "m"\nreasoningEffort = "low"\n', "utf8");

		updateUserConfigValue(["reasoning_effort"], () => "high", file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /reasoningEffort = "high"/);
		// 补出第二条会让下次读取报「两个都写且不一致」，整份配置失效
		assert.doesNotMatch(text, /reasoning_effort/);
	});

	it("带 BOM 的配置也能写回，且 BOM 保留", () => {
		const file = join(directory, "bom.toml");
		writeFileSync(file, `\uFEFFprovider = "p"\nmodel = "m"\n`, "utf8");

		updateUserConfigValue(["provider"], () => "q", file);

		const text = readFileSync(file, "utf8");
		assert.equal(text.startsWith("\uFEFF"), true);
		assert.match(text, /provider = "q"/);
	});

	it("文件末尾没有换行时插入新键不会拼坏行", () => {
		const file = join(directory, "no-newline.toml");
		// 手改过的配置常删掉最后一行换行
		writeFileSync(file, 'provider = "p"\nmodel = "m"', "utf8");

		updateUserConfigValue(["reasoning_effort"], () => "high", file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /model = "m"\nreasoning_effort = "high"/);
	});

	it("父表以点号键存在时不再补表头", () => {
		const file = join(directory, "dotted.toml");
		writeFileSync(file, 'provider = "p"\nmodel = "m"\nplugins.disabled = []\n', "utf8");

		updateUserConfigValue(["plugins", "disabled"], () => ["a"], file);

		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /\[plugins\]/);
		assert.match(text, /plugins\.disabled = \[/);
	});

	it("父表以点号键存在时新键沿用点号键，写回后仍可加载", () => {
		const file = join(directory, "dotted-new.toml");
		writeFileSync(file, 'provider = "p"\nmodel = "m"\nplugins.disabled = []\n', "utf8");

		updateUserConfigValue(["plugins", "trusted"], () => ["/a"], file);

		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /\[plugins\]/);
		assert.deepEqual(parseConfig(text, file).plugins.trusted, ["/a"]);
	});

	it("父表是内联表时把键写进那个值，写回后仍可加载", () => {
		const file = join(directory, "inline.toml");
		writeFileSync(file, 'provider = "p"\nmodel = "m"\nplugins = {}\n', "utf8");

		updateUserConfigValue(["plugins", "trusted"], () => ["/a"], file);

		const text = readFileSync(file, "utf8");
		// 写到根级会让下次加载报「未知键」，整份配置失效
		assert.doesNotMatch(text, /^trusted =/m);
		assert.deepEqual(parseConfig(text, file).plugins.trusted, ["/a"]);
	});
});

describe("追加 MCP server", () => {
	it("在已有分段后追加新段，保留注释并能重新加载", () => {
		const file = join(directory, "mcp.toml");
		writeFileSync(
			file,
			'# 保留这行注释\nprovider = "p"\nmodel = "m"\n\n[mcp_servers.old]\ntype = "stdio"\ncommand = "node"\n',
			"utf8",
		);

		appendMcpServerSection(
			"docs",
			{ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer demo" } },
			file,
		);

		const text = readFileSync(file, "utf8");
		assert.match(text, /# 保留这行注释/);
		const config = parseConfig(text, file);
		assert.deepEqual(
			config.mcpServers.map((server) => [server.name, server.type, server.url]),
			[
				["old", "stdio", undefined],
				["docs", "http", "https://example.com/mcp"],
			],
		);
	});

	it("配置使用 camelCase 时沿用原表名", () => {
		const file = join(directory, "mcp-camel.toml");
		writeFileSync(
			file,
			'provider = "p"\nmodel = "m"\n\n[mcpServers.old]\ntype = "http"\nurl = "https://old.example.com"\n',
			"utf8",
		);

		appendMcpServerSection("docs", { type: "http", url: "https://example.com/mcp" }, file);

		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /\[mcp_servers\./);
		assert.deepEqual(
			parseConfig(text, file).mcpServers.map((server) => server.name),
			["old", "docs"],
		);
	});

	it("同名 server 与无法扩展的内联表都拒绝写入", () => {
		const duplicate = join(directory, "mcp-duplicate.toml");
		writeFileSync(
			duplicate,
			'provider = "p"\nmodel = "m"\n\n[mcp_servers.old]\ntype = "http"\nurl = "https://old.example.com"\n',
			"utf8",
		);
		const before = readFileSync(duplicate, "utf8");
		assert.throws(
			() => appendMcpServerSection("old", { type: "http", url: "https://new.example.com" }, duplicate),
			/已存在/,
		);
		assert.equal(readFileSync(duplicate, "utf8"), before);

		const inline = join(directory, "mcp-inline.toml");
		writeFileSync(
			inline,
			'provider = "p"\nmodel = "m"\nmcp_servers = { old = { type = "http", url = "https://old.example.com" } }\n',
			"utf8",
		);
		const inlineBefore = readFileSync(inline, "utf8");
		assert.throws(
			() => appendMcpServerSection("docs", { type: "http", url: "https://example.com" }, inline),
			/无法追加 MCP 服务器/,
		);
		assert.equal(readFileSync(inline, "utf8"), inlineBefore);
	});
});

describe("编辑与删除 MCP server", () => {
	it("只替换目标段，保留其他段与注释", () => {
		const file = join(directory, "mcp-update.toml");
		writeFileSync(
			file,
			'# 保留这行注释\nprovider = "p"\nmodel = "m"\n\n[mcp_servers.old]\ntype = "stdio"\ncommand = "node"\n\n[mcp_servers.keep]\ntype = "http"\nurl = "https://keep.example.com"\n',
			"utf8",
		);

		updateMcpServerSection("old", { type: "http", url: "https://new.example.com" }, file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /# 保留这行注释/);
		const config = parseConfig(text, file);
		const old = config.mcpServers.find((server) => server.name === "old");
		assert.equal(old?.type, "http");
		assert.equal(old?.url, "https://new.example.com");
		assert.equal(old?.command, undefined);
		const keep = config.mcpServers.find((server) => server.name === "keep");
		assert.equal(keep?.url, "https://keep.example.com");
	});

	it("删除目标段，保留其他段", () => {
		const file = join(directory, "mcp-remove.toml");
		writeFileSync(
			file,
			'provider = "p"\nmodel = "m"\n\n[mcp_servers.old]\ntype = "http"\nurl = "https://old.example.com"\n\n[mcp_servers.keep]\ntype = "http"\nurl = "https://keep.example.com"\n',
			"utf8",
		);

		removeMcpServerSection("old", file);

		const config = parseConfig(readFileSync(file, "utf8"), file);
		assert.deepEqual(config.mcpServers.map((server) => server.name), ["keep"]);
	});

	it("camelCase 表名沿用原写法", () => {
		const file = join(directory, "mcp-camel-update.toml");
		writeFileSync(
			file,
			'provider = "p"\nmodel = "m"\n\n[mcpServers.old]\ntype = "http"\nurl = "https://old.example.com"\n',
			"utf8",
		);

		updateMcpServerSection("old", { type: "http", url: "https://new.example.com" }, file);

		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /\[mcp_servers\./);
		assert.equal(parseConfig(text, file).mcpServers[0]?.url, "https://new.example.com");
	});

	it("内联表形式可以编辑与删除", () => {
		const file = join(directory, "mcp-inline-edit.toml");
		writeFileSync(
			file,
			'provider = "p"\nmodel = "m"\nmcp_servers = { old = { type = "http", url = "https://old.example.com" }, keep = { type = "http", url = "https://keep.example.com" } }\n',
			"utf8",
		);

		updateMcpServerSection("old", { type: "http", url: "https://new.example.com" }, file);
		let config = parseConfig(readFileSync(file, "utf8"), file);
		assert.equal(config.mcpServers.find((server) => server.name === "old")?.url, "https://new.example.com");
		assert.equal(config.mcpServers.find((server) => server.name === "keep")?.url, "https://keep.example.com");

		removeMcpServerSection("old", file);
		config = parseConfig(readFileSync(file, "utf8"), file);
		assert.deepEqual(config.mcpServers.map((server) => server.name), ["keep"]);
	});

	it("目标不存在时报错且不改文件", () => {
		const file = join(directory, "mcp-missing.toml");
		writeFileSync(
			file,
			'[mcp_servers.keep]\ntype = "http"\nurl = "https://keep.example.com"\n',
			"utf8",
		);
		const before = readFileSync(file, "utf8");
		assert.throws(() => updateMcpServerSection("missing", { type: "http", url: "https://x" }, file), /不存在/);
		assert.equal(readFileSync(file, "utf8"), before);
		assert.throws(() => removeMcpServerSection("missing", file), /不存在/);
		assert.equal(readFileSync(file, "utf8"), before);
	});

	it("编辑与删除保留 CRLF", () => {
		const file = join(directory, "mcp-crlf.toml");
		writeFileSync(
			file,
			'[mcp_servers.old]\r\ntype = "http"\r\nurl = "https://old.example.com"\r\n\r\n[mcp_servers.keep]\r\ntype = "http"\r\nurl = "https://keep.example.com"\r\n',
			"utf8",
		);

		updateMcpServerSection("old", { type: "http", url: "https://new.example.com" }, file);
		removeMcpServerSection("keep", file);

		const text = readFileSync(file, "utf8");
		assert.match(text, /\r\n/);
		assert.doesNotMatch(text, /(?<!\r)\n/);
	});
});
