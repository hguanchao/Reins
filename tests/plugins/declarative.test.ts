import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { McpServerConfig } from "../../src/config/file.ts";
import {
	describeDeclarativeScan,
	mergeMcpServers,
	scanDeclarativePlugins,
} from "../../src/plugins/declarative.ts";

const created: string[] = [];

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-plugins-"));
	created.push(directory);
	return directory;
}

/** 建一个插件目录并写入一个 JSON 文件。 */
function pluginOf(base: string, name: string, file: string, value: unknown): string {
	const root = join(base, name);
	mkdirSync(join(root, file, ".."), { recursive: true });
	writeFileSync(join(root, file), JSON.stringify(value, null, 2), "utf8");
	return root;
}

function skillAt(root: string, relative: string): string {
	const directory = join(root, relative);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), ["---", "name: demo", "description: 演示", "---"].join("\n"), "utf8");
	return directory;
}

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("声明式插件发现", () => {
	it("Claude 清单：技能目录与内联 MCP 声明都能读出来", () => {
		const base = workspace();
		const root = pluginOf(base, "claude-pack", "plugin.json", {
			name: "claude-pack",
			skills: "skills",
			mcpServers: {
				fs: { command: "npx", args: ["-y", "server-fs"], env: { TOKEN: "abc" } },
			},
		});
		skillAt(root, join("skills", "pdf"));

		const scan = scanDeclarativePlugins(base);
		assert.deepEqual(scan.failures, []);
		assert.equal(scan.plugins.length, 1);
		const plugin = scan.plugins[0]!;

		assert.equal(plugin.name, "claude-pack");
		assert.equal(plugin.manifest, "plugin.json");
		// 父目录形态：下面每个子目录是一个技能
		assert.deepEqual(plugin.skillDirectories, [{ directory: join(root, "skills"), single: false }]);
		assert.deepEqual(plugin.mcpServers, [
			{
				name: "fs",
				type: "stdio",
				command: "npx",
				args: ["-y", "server-fs"],
				url: undefined,
				headers: {},
				env: { TOKEN: "abc" },
				timeoutSeconds: undefined,
				disabled: false,
			},
		]);
	});

	it("pi 清单：单个技能目录按 single 收，没有对应机制的部件逐条列出", () => {
		const base = workspace();
		const root = pluginOf(base, "pi-pack", "package.json", {
			name: "pi-pack",
			pi: {
				skills: ["./skills/pdf"],
				extensions: ["./ext.ts"],
				prompts: ["./prompts/review.md"],
				themes: ["./themes/dark.json"],
			},
		});
		skillAt(root, join("skills", "pdf"));

		const plugin = scanDeclarativePlugins(base).plugins[0]!;
		assert.equal(plugin.manifest, "package.json#pi");
		assert.deepEqual(plugin.skillDirectories, [{ directory: join(root, "skills", "pdf"), single: true }]);
		assert.equal(plugin.unsupported.length, 3);
		assert.ok(plugin.unsupported.some((item) => item.startsWith("extensions")));
		assert.ok(plugin.unsupported.some((item) => item.startsWith("prompts")));
		assert.ok(plugin.unsupported.some((item) => item.startsWith("themes")));
	});

	it("没有清单时按约定目录认出插件", () => {
		const base = workspace();
		const root = join(base, "convention-pack");
		mkdirSync(root, { recursive: true });
		skillAt(root, join("skills", "alpha"));
		mkdirSync(join(root, "commands"), { recursive: true });

		const plugin = scanDeclarativePlugins(base).plugins[0]!;
		assert.equal(plugin.manifest, "convention");
		assert.equal(plugin.name, "convention-pack");
		assert.deepEqual(plugin.skillDirectories, [{ directory: join(root, "skills"), single: false }]);
		assert.ok(plugin.unsupported.some((item) => item.startsWith("commands")));
	});

	it("空目录与普通文件不算插件", () => {
		const base = workspace();
		mkdirSync(join(base, "empty"), { recursive: true });
		writeFileSync(join(base, "loose.ts"), "export default {}", "utf8");

		assert.deepEqual(scanDeclarativePlugins(base), { plugins: [], failures: [] });
	});

	it("逃出插件根的路径被拒绝，并留下告警", () => {
		const base = workspace();
		pluginOf(base, "escape", "plugin.json", { name: "escape", skills: ["../outside"] });
		mkdirSync(join(base, "outside"), { recursive: true });

		const plugin = scanDeclarativePlugins(base).plugins[0]!;
		assert.deepEqual(plugin.skillDirectories, []);
		assert.ok(plugin.warnings.some((warning) => warning.includes("escapes the plugin root")));
	});

	it("MCP 声明写成文件时按相对插件根的路径读", () => {
		const base = workspace();
		const root = pluginOf(base, "file-mcp", "plugin.json", { name: "file-mcp", mcpServers: ".mcp.json" });
		writeFileSync(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } } }),
			"utf8",
		);

		const plugin = scanDeclarativePlugins(base).plugins[0]!;
		assert.equal(plugin.mcpServers.length, 1);
		assert.equal(plugin.mcpServers[0]!.type, "http");
		assert.equal(plugin.mcpServers[0]!.url, "https://example.test/mcp");
	});

	it("MCP 声明缺少 command 与 url 时明确报错", () => {
		const base = workspace();
		pluginOf(base, "bad-mcp", "plugin.json", { name: "bad-mcp", mcpServers: { broken: { args: ["x"] } } });

		const scan = scanDeclarativePlugins(base);
		assert.deepEqual(scan.plugins, []);
		assert.equal(scan.failures.length, 1);
		assert.match(scan.failures[0]!.message, /needs either command or url/);
	});

	it("Cordis 代码插件明确报为不支持，而不是当成没装", () => {
		const base = workspace();
		pluginOf(base, "dsh-tool", "package.json", {
			name: "@deepseek-ai/dsh-tool-todo",
			peerDependencies: { "@deepseek-ai/cordis": "workspace:~" },
		});

		const scan = scanDeclarativePlugins(base);
		assert.deepEqual(scan.plugins, []);
		assert.equal(scan.failures.length, 1);
		assert.match(scan.failures[0]!.message, /Cordis code plugin/);
	});

	it("同名插件只收第一个，其余报冲突", () => {
		const base = workspace();
		pluginOf(base, "one", "plugin.json", { name: "same", skills: "skills" });
		pluginOf(base, "two", "plugin.json", { name: "same", skills: "skills" });

		const scan = scanDeclarativePlugins(base);
		assert.equal(scan.plugins.length, 1);
		assert.equal(scan.failures.length, 1);
		assert.match(scan.failures[0]!.message, /already used by/);
	});
});

describe("插件 MCP 合并", () => {
	const configured: McpServerConfig = {
		name: "fs",
		type: "stdio",
		command: "configured",
		args: [],
		url: undefined,
		headers: {},
		env: {},
		timeoutSeconds: undefined,
		disabled: false,
	};

	it("配置优先：插件声明同名 server 时忽略并告警", () => {
		const plugin = {
			name: "pack",
			root: "/p",
			manifest: "plugin.json",
			skillDirectories: [],
			mcpServers: [{ ...configured, command: "from-plugin" }],
			unsupported: [],
			warnings: [],
		};

		const merged = mergeMcpServers([configured], [plugin]);
		assert.deepEqual(merged.servers, [configured]);
		assert.equal(merged.warnings.length, 1);
		assert.match(merged.warnings[0]!, /already configured/);
	});

	it("不重名时追加在配置之后", () => {
		const plugin = {
			name: "pack",
			root: "/p",
			manifest: "plugin.json",
			skillDirectories: [],
			mcpServers: [{ ...configured, name: "extra" }],
			unsupported: [],
			warnings: [],
		};

		const merged = mergeMcpServers([configured], [plugin]);
		assert.deepEqual(
			merged.servers.map((server) => server.name),
			["fs", "extra"],
		);
		assert.deepEqual(merged.warnings, []);
	});
});

describe("装载报告", () => {
	it("每个插件一行结论，不支持与失败各自成行", () => {
		const lines = describeDeclarativeScan(
			{
				plugins: [
					{
						name: "pack",
						root: "/p",
						manifest: "plugin.json",
						skillDirectories: [{ directory: "/p/skills", single: false }],
						mcpServers: [],
						unsupported: ["hooks: Reins has no hook event points"],
						warnings: [],
					},
				],
				failures: [{ plugin: "broken", message: "no manifest" }],
			},
			["Plugin pack: MCP server fs is already configured; the plugin's declaration is ignored"],
		);

		assert.equal(lines[0], "plugin pack (plugin.json): 1 skill dir(s)");
		assert.ok(lines.some((line) => line.includes("unsupported — hooks")));
		assert.ok(lines.some((line) => line.startsWith("plugin broken: failed —")));
		assert.ok(lines.some((line) => line.includes("already configured")));
	});

	it("什么都没有的插件也要说清楚", () => {
		const lines = describeDeclarativeScan({
			plugins: [
				{
					name: "empty",
					root: "/p",
					manifest: "convention",
					skillDirectories: [],
					mcpServers: [],
					unsupported: [],
					warnings: [],
				},
			],
			failures: [],
		});

		assert.deepEqual(lines, ["plugin empty (convention): nothing usable"]);
	});
});
