import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseConfig } from "../../src/config/file.ts";
import { updateModelSelection, updateUserConfigValue } from "../../src/config/write-back.ts";

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
