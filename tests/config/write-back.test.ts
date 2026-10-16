import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { ConfigError } from "../../src/config/config-error.ts";
import { updateUserConfigValue } from "../../src/config/write-back.ts";

const home = mkdtempSync(join(tmpdir(), "reins-write-back-"));
const file = join(home, "config.toml");

beforeEach(() => {
	rmSync(file, { force: true });
});

after(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("回写用户级配置", () => {
	it("文件不存在时新建出来", () => {
		updateUserConfigValue(["ui", "notify"], () => "bell", file);
		assert.ok(readFileSync(file, "utf8").includes('notify = "bell"'));
	});

	it("改已有键时保留注释与排版", () => {
		writeFileSync(
			file,
			[
				"# 我的说明",
				'provider = "p"   # 换掉它',
				"",
				"[ui]",
				'notify = "auto"',
				"",
			].join("\n"),
		);

		updateUserConfigValue(["ui", "notify"], () => "desktop", file);

		const written = readFileSync(file, "utf8");
		assert.ok(written.includes("# 我的说明"));
		assert.ok(written.includes('provider = "p"   # 换掉它'));
		assert.ok(written.includes('notify = "desktop"'));
		assert.ok(!written.includes('"auto"'));
	});

	it("update 拿到的是当前值", () => {
		writeFileSync(file, 'notify = "bell"\n');
		let seen: unknown = "没拿到";
		updateUserConfigValue(["notify"], (current) => {
			seen = current;
			return "off";
		}, file);
		assert.equal(seen, "bell");
	});

	it("算新的值时抛错不落盘", () => {
		writeFileSync(file, 'notify = "auto"\n');
		assert.throws(
			() =>
				updateUserConfigValue(["notify"], () => {
					throw new Error("算不出来");
				}, file),
			/算不出来/,
		);
		assert.equal(readFileSync(file, "utf8"), 'notify = "auto"\n');
	});

	it("读写失败时报成配置错误", () => {
		// 目录当文件用，读或写必然失败
		assert.throws(
			() => updateUserConfigValue(["ui", "notify"], () => "bell", home),
			(error) => error instanceof ConfigError && /配置失败/.test(error.message),
		);
	});
});
