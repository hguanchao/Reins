import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

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
});
