import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SettingsSnapshot } from "#web/protocol.ts";
import {
	countExtensions,
	extensionItems,
	filterExtensions,
	filterSettingsNav,
	formatKb,
	parseArgumentLines,
	parseKeyValueLines,
	personalizationBytes,
} from "#web/settings/settings-model.ts";

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
	return {
		version: "1.0.0",
		configPath: "/home/.reins/config.toml",
		providersPath: "/home/.reins/providers.json",
		provider: "p1",
		model: "m1",
		effort: "off",
		approval: "ask",
		sandbox: "off",
		contextWindow: 100_000,
		maxTokens: 8_192,
		compactModel: undefined,
		reviewModel: undefined,
		models: [],
		mcpServers: [],
		plugins: [],
		skills: [],
		...overrides,
	};
}

describe("扩展清单", () => {
	it("把插件、技能与 MCP 摊平成同一种行", () => {
		const settings = snapshot({
			plugins: [{ name: "filesystem", kind: "dsh", disabled: false }],
			skills: [{ name: "writer", description: "写文档", path: "/skills/writer/SKILL.md" }],
			mcpServers: [{ name: "docs", type: "http", disabled: true, status: "connected", detail: "3 tools" }],
		});

		const items = extensionItems(settings);
		assert.deepEqual(
			items.map((item) => [item.kind, item.name, item.meta, item.disabled]),
			[
				["plugin", "filesystem", "DSH 兼容", false],
				["skill", "writer", "技能", false],
				["mcp", "docs", "http", true],
			],
		);
		assert.deepEqual(countExtensions(items), { plugin: 1, skill: 1, mcp: 1 });
		const mcp = items.find((item) => item.kind === "mcp");
		assert.equal(mcp?.status, "connected");
		assert.equal(mcp?.detail, "3 tools");
	});

	it("设置未读到时返回空清单", () => {
		assert.deepEqual(extensionItems(undefined), []);
	});
});

describe("扩展搜索", () => {
	const items = extensionItems(
		snapshot({
			plugins: [{ name: "Filesystem", kind: "dsh", disabled: false }],
			skills: [{ name: "writer", description: "写文档", path: "/skills/writer/SKILL.md" }],
			mcpServers: [{ name: "docs", type: "http", disabled: false, status: "unreachable", detail: "timeout" }],
		}),
	);

	it("名称、描述和类型都参与匹配，忽略大小写与首尾空白", () => {
		assert.deepEqual(
			filterExtensions(items, " filesystem ").map((item) => item.name),
			["Filesystem"],
		);
		assert.deepEqual(
			filterExtensions(items, "写文档").map((item) => item.name),
			["writer"],
		);
		assert.deepEqual(
			filterExtensions(items, "http").map((item) => item.name),
			["docs"],
		);
	});

	it("空查询保持完整清单，没有命中时返回空表", () => {
		assert.equal(filterExtensions(items, ""), items);
		assert.deepEqual(filterExtensions(items, "missing"), []);
	});
});

describe("个性化计数器", () => {
	it("按 UTF-8 计字节，中文按三字节算", () => {
		assert.equal(personalizationBytes(""), 0);
		assert.equal(personalizationBytes("abc"), 3);
		assert.equal(personalizationBytes("回答"), 6);
	});

	it("KB 读数在 10KB 以下保留一位小数", () => {
		assert.equal(formatKb(0), "0 KB");
		assert.equal(formatKb(1024), "1.0 KB");
		assert.equal(formatKb(32 * 1024), "32 KB");
	});
});

describe("键值行解析", () => {
	it("按第一个等号拆分，忽略空行与首尾空白", () => {
		assert.deepEqual(
			parseKeyValueLines("  Authorization = Bearer demo  \n\nX-Trace=1=2\n"),
			{ ok: true, value: { Authorization: "Bearer demo", "X-Trace": "1=2" } },
		);
	});

	it("缺等号或空键时返回错误", () => {
		assert.equal(parseKeyValueLines("no-equals").ok, false);
		assert.equal(parseKeyValueLines("=value").ok, false);
	});

	it("参数按行拆分并去掉空行", () => {
		assert.deepEqual(parseArgumentLines(" -y \n\n@scope/server  \n  E:/work "), [
			"-y",
			"@scope/server",
			"E:/work",
		]);
	});
});

describe("设置导航过滤", () => {
	const groups = [
		{ label: "基础设置", items: [{ label: "常规" }, { label: "外观" }] },
		{ label: "Agent 能力", items: [{ label: "个性化" }, { label: "扩展管理" }] },
	];

	it("空查询返回原分组", () => {
		assert.equal(filterSettingsNav(groups, ""), groups);
	});

	it("命中项保留，整组无命中时隐藏该组", () => {
		assert.deepEqual(filterSettingsNav(groups, "外观"), [
			{ label: "基础设置", items: [{ label: "外观" }] },
		]);
		assert.deepEqual(filterSettingsNav(groups, "管理"), [
			{ label: "Agent 能力", items: [{ label: "扩展管理" }] },
		]);
		assert.deepEqual(filterSettingsNav(groups, "模型"), []);
	});
});
