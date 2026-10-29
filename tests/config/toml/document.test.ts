import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TomlDocument } from "../../../src/config/toml/document.ts";

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
