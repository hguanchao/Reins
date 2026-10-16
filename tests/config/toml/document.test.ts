import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TomlDocument } from "../../../src/config/toml/document.ts";

describe("TomlDocument 读取", () => {
	const document = new TomlDocument(`
provider = "example-openai"
model = "gpt-5.2"

[ui]
notify = "auto"
`);

	it("按键路径取值", () => {
		assert.equal(document.get(["provider"]), "example-openai");
		assert.equal(document.get(["ui", "notify"]), "auto");
		assert.deepEqual(document.get(["ui"]), { notify: "auto" });
	});

	it("路径不存在或中途不是表时返回 undefined", () => {
		assert.equal(document.get(["missing"]), undefined);
		assert.equal(document.get(["provider", "deeper"]), undefined);
	});

	it("给出键在原文中的位置", () => {
		assert.deepEqual(document.locationOf(["model"]), { line: 3, column: 1 });
		assert.deepEqual(document.locationOf(["ui", "notify"]), { line: 6, column: 1 });
		assert.deepEqual(document.locationOf(["ui"]), { line: 5, column: 1 });
		assert.equal(document.locationOf(["missing"]), undefined);
	});
});

describe("TomlDocument 定点回写", () => {
	it("替换已有键的值时保留行尾注释与其他内容", () => {
		const source = [
			"# 顶部说明",
			'provider = "example-openai"',
			'model = "gpt-5.2"   # 想换成别的模型就改这里',
			"",
			"[ui]",
			'notify = "auto"',
			"",
		].join("\n");

		const document = new TomlDocument(source);
		document.set(["model"], "gpt-5.3");

		assert.equal(
			document.source,
			[
				"# 顶部说明",
				'provider = "example-openai"',
				'model = "gpt-5.3"   # 想换成别的模型就改这里',
				"",
				"[ui]",
				'notify = "auto"',
				"",
			].join("\n"),
		);
	});

	it("写入数组与布尔时按 TOML 字面量输出", () => {
		const document = new TomlDocument('[plugins]\ndisabled = []\n');
		document.set(["plugins", "disabled"], ["a-plugin", "b-plugin"]);
		assert.equal(document.source, '[plugins]\ndisabled = ["a-plugin", "b-plugin"]\n');
	});

	it("表已存在时把新键插到该区段末尾", () => {
		const document = new TomlDocument('[ui]\nnotify = "auto"\n\n[plugins]\ndisabled = []\n');
		document.set(["ui", "theme"], "dark");

		// 新键落在 [ui] 区段内，不会跑到 [plugins] 后面
		assert.equal(document.source, '[ui]\nnotify = "auto"\ntheme = "dark"\n\n[plugins]\ndisabled = []\n');
		// 插在描述下一个表头的注释之前
		const withComment = new TomlDocument('[ui]\nnotify = "auto"\n\n# 插件开关\n[plugins]\n');
		withComment.set(["ui", "theme"], "dark");
		assert.equal(withComment.source, '[ui]\nnotify = "auto"\ntheme = "dark"\n\n# 插件开关\n[plugins]\n');
	});

	it("顶层键缺失时插到根区段末尾", () => {
		const document = new TomlDocument('provider = "x"\n\n# 界面\n[ui]\nnotify = "auto"\n');
		document.set(["max_retries"], 3);
		assert.equal(document.source, 'provider = "x"\nmax_retries = 3\n\n# 界面\n[ui]\nnotify = "auto"\n');
	});

	it("整个表都不存在时在文件末尾补出表头", () => {
		// 与真实配置文件一致的情形：这张表整段都是注释，解析结果里并不存在
		const source = [
			'provider = "example-openai"',
			'model = "gpt-5.2"',
			"",
			"# ── 插件与运行时状态 ──",
			"# [plugins]",
			'# disabled = ["mcp-plugin"]',
			"# trusted = []",
			"",
		].join("\n");

		const document = new TomlDocument(source);
		assert.equal(document.get(["plugins", "trusted"]), undefined);

		document.set(["plugins", "trusted"], ["E:\\Projects\\Reins"]);

		assert.equal(
			document.source,
			[
				'provider = "example-openai"',
				'model = "gpt-5.2"',
				"",
				"# ── 插件与运行时状态 ──",
				"# [plugins]",
				'# disabled = ["mcp-plugin"]',
				"# trusted = []",
				"",
				"[plugins]",
				'trusted = ["E:\\\\Projects\\\\Reins"]',
				"",
			].join("\n"),
		);
	});

	it("追加表头时会补足换行", () => {
		const noTrailing = new TomlDocument('model = "x"');
		noTrailing.set(["plugins", "trusted"], ["/a"]);
		assert.equal(noTrailing.source, 'model = "x"\n\n[plugins]\ntrusted = ["/a"]\n');

		const empty = new TomlDocument("");
		empty.set(["plugins", "trusted"], ["/a"]);
		assert.equal(empty.source, '[plugins]\ntrusted = ["/a"]\n');
	});

	it("连续回写不会互相错位", () => {
		const document = new TomlDocument('model = "a"\n');
		document.set(["model"], "b");
		document.set(["plugins", "trusted"], ["/root"]);
		document.set(["model"], "c");

		assert.equal(document.source, 'model = "c"\n\n[plugins]\ntrusted = ["/root"]\n');
		// 回写后内部的值树同步更新
		assert.equal(document.get(["model"]), "c");
		assert.deepEqual(document.get(["plugins"]), { trusted: ["/root"] });
	});

	it("键名需要引号时自动加上", () => {
		const document = new TomlDocument("[mcp_servers.docs]\nurl = \"x\"\n");
		document.set(["mcp_servers", "docs", "headers"], { Authorization: "Bearer abc" });
		assert.equal(
			document.source,
			'[mcp_servers.docs]\nurl = "x"\nheaders = { Authorization = "Bearer abc" }\n',
		);
	});

	it("拒绝空路径", () => {
		assert.throws(() => new TomlDocument("").set([], 1), /路径不能为空/);
	});
});
