import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TomlDocument } from "#src/config/toml/document.ts";

describe("TOML 文档", () => {
	it("按键路径取值", () => {
		const document = new TomlDocument(`model = "m"\n[ui]\nnotify = "bell"\n`);
		assert.equal(document.get(["model"]), "m");
		assert.equal(document.get(["ui", "notify"]), "bell");
		assert.equal(document.get(["ui", "missing"]), undefined);
		assert.equal(document.get(["ui", "notify", "deep"]), undefined);
	});

	it("locationOf 指到赋值的键首", () => {
		const source = `model = "m"\n[ui]\nnotify = "bell"\n`;
		const document = new TomlDocument(source);
		const model = document.locationOf(["model"]);
		assert.deepEqual(model, { line: 1, column: 1 });
		const notify = document.locationOf(["ui", "notify"]);
		assert.deepEqual(notify, { line: 3, column: 1 });
		assert.equal(document.locationOf(["missing"]), undefined);
	});

	it("set 已存在的键只替换值那一段", () => {
		const document = new TomlDocument(`# 注释保留\nmodel = "old" # 尾注\n`);
		document.set(["model"], "new");
		assert.equal(document.source, `# 注释保留\nmodel = "new" # 尾注\n`);
		assert.equal(document.get(["model"]), "new");
	});

	it("set 新键插到所属表区段的末尾", () => {
		const document = new TomlDocument(`[ui]\nnotify = "bell"\n`);
		document.set(["ui", "bell"], true);
		assert.equal(document.source, `[ui]\nnotify = "bell"\nbell = true\n`);
	});

	it("set 整个表不存在时补一个表头", () => {
		const document = new TomlDocument(`model = "m"\n`);
		document.set(["plugins", "trusted"], ["/a", "/b"]);
		assert.equal(
			document.source,
			`model = "m"\n\n[plugins]\ntrusted = ["/a", "/b"]\n`,
		);
	});

	it("追加前留空行，不与既有内容粘连", () => {
		const document = new TomlDocument(`model = "m"`);
		document.set(["plugins", "trusted"], []);
		assert.equal(document.source, `model = "m"\n\n[plugins]\ntrusted = []\n`);
	});

	it("set 沿用文件既有的 CRLF", () => {
		const document = new TomlDocument(`model = "m"\r\n[ui]\r\nnotify = "bell"\r\n`);
		document.set(["ui", "bell"], true);
		assert.equal(document.source, `model = "m"\r\n[ui]\r\nnotify = "bell"\r\nbell = true\r\n`);
	});

	it("CRLF 文件里替换值同样只动那一段", () => {
		const document = new TomlDocument(`model = "old"\r\n`);
		document.set(["model"], "new");
		assert.equal(document.source, `model = "new"\r\n`);
	});

	it("空路径的 set 报错", () => {
		const document = new TomlDocument(`a = 1`);
		assert.throws(() => document.set([], 1), /must not be empty/);
	});

	it("回写对象值时序列化成内联表", () => {
		const document = new TomlDocument(`[a]\nx = 1\n`);
		document.set(["a", "x"], { y: 2 });
		assert.equal(document.source, `[a]\nx = { y = 2 }\n`);
	});

	it("父表是内联表时改写其中的键，不新增根级键", () => {
		const document = new TomlDocument(`model = "m"\nui = { notify = "auto" }\n`);
		document.set(["ui", "notify"], "bell");
		assert.equal(document.source, `model = "m"\nui = { notify = "bell" }\n`);
		assert.equal(document.get(["ui", "notify"]), "bell");
		assert.equal(document.get(["notify"]), undefined);
	});

	it("父表是内联表时新键并进同一个值", () => {
		const document = new TomlDocument(`ui = { notify = "auto" }\n`);
		document.set(["ui", "bell"], true);
		assert.equal(document.source, `ui = { notify = "auto", bell = true }\n`);
		assert.equal(document.get(["ui", "bell"]), true);
	});

	it("空内联表同样可以写入，不会退化成根级键", () => {
		const document = new TomlDocument(`plugins = {}\n`);
		document.set(["plugins", "trusted"], ["/a"]);
		assert.equal(document.source, `plugins = { trusted = ["/a"] }\n`);
		assert.deepEqual(document.get(["plugins", "trusted"]), ["/a"]);
	});

	it("父表是点号键时沿用点号键追加，不补表头", () => {
		const document = new TomlDocument(`plugins.disabled = []\n`);
		document.set(["plugins", "trusted"], ["/a"]);
		assert.equal(document.source, `plugins.disabled = []\nplugins.trusted = ["/a"]\n`);
		assert.deepEqual(document.get(["plugins", "trusted"]), ["/a"]);
	});

	it("别名写法的内联表按别名写入，读路径仍能取到", () => {
		const document = new TomlDocument(`mcpServers = { a = 1 }\n`);
		document.set(["mcp_servers", "b"], 2);
		assert.equal(document.source, `mcpServers = { a = 1, b = 2 }\n`);
		assert.equal(document.get(["mcpServers", "b"]), 2);
	});

	it("父表不是表时拒绝写入，且不改动原文", () => {
		const source = `ui = 1\n`;
		const document = new TomlDocument(source);
		assert.throws(() => document.set(["ui", "notify"], "bell"), /Duplicate definition|Cannot write/);
		assert.equal(document.source, source);
	});
});

describe("TOML 表段替换与删除", () => {
	it("替换分节形式的表，保留段外注释与其他 server", () => {
		const source = `# 顶部注释\n[mcp_servers.a]\ncommand = "old"\n\n[mcp_servers.b]\ncommand = "keep"\n`;
		const document = new TomlDocument(source);
		document.replaceSection(["mcp_servers", "a"], { command: "new", args: ["-y"] });
		assert.equal(document.get(["mcp_servers", "a", "command"]), "new");
		assert.deepEqual(document.get(["mcp_servers", "a", "args"]), ["-y"]);
		assert.equal(document.get(["mcp_servers", "b", "command"]), "keep");
		assert.match(document.source, /# 顶部注释/);
		assert.match(document.source, /\[mcp_servers\.b\]/);
		assert.doesNotMatch(document.source, /command = "old"/);
	});

	it("替换时连同子段一起收掉，改成内联表", () => {
		const source = `[mcp_servers.a]\ncommand = "old"\n[mcp_servers.a.env]\nTOKEN = "x"\n[mcp_servers.b]\ncommand = "keep"\n`;
		const document = new TomlDocument(source);
		document.replaceSection(["mcp_servers", "a"], {
			command: "new",
			env: { TOKEN: "y" },
		});
		assert.deepEqual(document.get(["mcp_servers", "a", "env"]), { TOKEN: "y" });
		assert.equal(document.get(["mcp_servers", "b", "command"]), "keep");
		assert.doesNotMatch(document.source, /\[mcp_servers\.a\.env\]/);
	});

	it("删除目标段与子段，保留其他段", () => {
		const source = `[mcp_servers.a]\ncommand = "old"\n[mcp_servers.a.env]\nTOKEN = "x"\n[mcp_servers.b]\ncommand = "keep"\n`;
		const document = new TomlDocument(source);
		document.removeSection(["mcp_servers", "a"]);
		assert.equal(document.get(["mcp_servers", "a"]), undefined);
		assert.equal(document.get(["mcp_servers", "b", "command"]), "keep");
		assert.doesNotMatch(document.source, /mcp_servers\.a/);
	});

	it("内联表形式替换目标键，保留其他键", () => {
		const source = `mcp_servers = { a = { command = "old" }, b = { command = "keep" } }\n`;
		const document = new TomlDocument(source);
		document.replaceSection(["mcp_servers", "a"], { command: "new" });
		assert.deepEqual(document.get(["mcp_servers", "a"]), { command: "new" });
		assert.deepEqual(document.get(["mcp_servers", "b"]), { command: "keep" });
	});

	it("内联表形式删除目标键，保留其他键", () => {
		const source = `mcp_servers = { a = { command = "old" }, b = { command = "keep" } }\n`;
		const document = new TomlDocument(source);
		document.removeSection(["mcp_servers", "a"]);
		assert.equal(document.get(["mcp_servers", "a"]), undefined);
		assert.deepEqual(document.get(["mcp_servers", "b"]), { command: "keep" });
	});

	it("点号键形式没有独立段，替换与删除都明确拒绝", () => {
		const source = `[mcp_servers]\na.command = "old"\n`;
		const document = new TomlDocument(source);
		assert.throws(
			() => document.replaceSection(["mcp_servers", "a"], { command: "new" }),
			/Cannot rewrite/,
		);
		assert.equal(document.source, source);
		assert.throws(() => document.removeSection(["mcp_servers", "a"]), /Cannot remove/);
		assert.equal(document.source, source);
	});

	it("目标不存在时拒绝替换与删除", () => {
		const document = new TomlDocument(`[mcp_servers.b]\ncommand = "keep"\n`);
		assert.throws(() => document.replaceSection(["mcp_servers", "a"], { command: "new" }), /Cannot rewrite/);
		assert.throws(() => document.removeSection(["mcp_servers", "a"]), /Cannot remove/);
	});

	it("替换分节时沿用 CRLF", () => {
		const source = `[mcp_servers.a]\r\ncommand = "old"\r\n[mcp_servers.b]\r\ncommand = "keep"\r\n`;
		const document = new TomlDocument(source);
		document.replaceSection(["mcp_servers", "a"], { command: "new" });
		assert.match(document.source, /\[mcp_servers\.a\]\r\ncommand = "new"\r\n/);
		assert.equal(document.source.includes("\n") && !document.source.includes("\r\n"), false);
	});
});
