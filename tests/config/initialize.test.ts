import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parseConfig } from "../../src/config/file.ts";
import { initializeConfigFiles } from "../../src/config/initialize.ts";
import { parseProviders } from "../../src/config/providers-file.ts";

let home: string;
let previous: string | undefined;

beforeEach(() => {
	previous = process.env["REINS_HOME"];
	home = mkdtempSync(join(tmpdir(), "reins-init-"));
	process.env["REINS_HOME"] = home;
});

afterEach(() => {
	if (previous === undefined) delete process.env["REINS_HOME"];
	else process.env["REINS_HOME"] = previous;
	rmSync(home, { recursive: true, force: true });
});

describe("初始化配置模板", () => {
	it("目录为空时创建两份模板，且互相能对上", () => {
		const created = initializeConfigFiles({ config: true, providers: true });

		assert.deepEqual(created, [join(home, "config.toml"), join(home, "providers.json")]);
		const config = parseConfig(readFileSync(join(home, "config.toml"), "utf8"), "config.toml");
		const providers = parseProviders(
			readFileSync(join(home, "providers.json"), "utf8"),
			"providers.json",
		);
		const provider = providers.providers.find((item) => item.id === config.provider);
		assert.ok(provider);
		assert.ok(provider.models.some((item) => item.id === config.model));
	});

	it("已有文件不覆盖，只补缺失的那一份", () => {
		const configFile = join(home, "config.toml");
		writeFileSync(configFile, 'provider = "keep"\nmodel = "keep"\n', "utf8");

		const created = initializeConfigFiles({ config: true, providers: true });

		assert.deepEqual(created, [join(home, "providers.json")]);
		assert.match(readFileSync(configFile, "utf8"), /provider = "keep"/);
	});

	it("只初始化被请求的那一份", () => {
		const created = initializeConfigFiles({ config: false, providers: true });

		assert.deepEqual(created, [join(home, "providers.json")]);
		assert.equal(existsSync(join(home, "config.toml")), false);
	});

	it("两份都不请求时连目录都不创建", () => {
		process.env["REINS_HOME"] = join(home, "nested");

		assert.deepEqual(initializeConfigFiles({ config: false, providers: false }), []);
		assert.equal(existsSync(join(home, "nested")), false);
	});
});
