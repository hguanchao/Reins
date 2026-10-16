import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { TomlDocument } from "../../src/config/toml/index.ts";
import {
	findProjectResources,
	findSavedDecision,
	readTrustedRoots,
	recordTrust,
	resolveTrust,
} from "../../src/workspace/trust.ts";

/**
 * 信任相关的用例会把配置目录指向临时目录。
 *
 * recordTrust 写的是用户级配置文件，所以必须先把配置目录挪开，否则会动到使用者真实的配置。
 */
const home = mkdtempSync(join(tmpdir(), "reins-trust-home-"));
const work = mkdtempSync(join(tmpdir(), "reins-trust-work-"));
const previousHome = process.env["REINS_HOME"];

beforeEach(() => {
	process.env["REINS_HOME"] = home;
	rmSync(home, { recursive: true, force: true });
});

after(() => {
	if (previousHome === undefined) delete process.env["REINS_HOME"];
	else process.env["REINS_HOME"] = previousHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
});

describe("工作区里的受保护资源", () => {
	it("没有项目目录时不必做信任决定", () => {
		const resources = findProjectResources(work);
		assert.deepEqual(resources.files, []);
	});

	it("列出确实存在的配置文件", () => {
		const directory = join(work, ".reins");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "config.toml"), 'provider = "p"\nmodel = "m"\n');
		writeFileSync(join(directory, "models.json"), "{}");

		const resources = findProjectResources(work);
		assert.equal(resources.files.length, 2);
		assert.ok(resources.files.some((path) => path.endsWith("config.toml")));
	});
});

describe("已记录的信任", () => {
	it("从工作区往上找最近的记录", () => {
		const nested = join(work, "a", "b", "c");
		assert.equal(findSavedDecision([work], nested), true);
	});

	it("信任子目录不等于信任整棵树", () => {
		const nested = join(work, "a", "b");
		assert.equal(findSavedDecision([nested], work), undefined);
	});

	it("大小写差异不算不同的目录", () => {
		const roots = [resolve(work).toUpperCase()];
		assert.equal(findSavedDecision(roots, work), true);
	});
});

describe("信任结论", () => {
	const base = { root: work, trustedRoots: [], ask: undefined, hasProtectedResources: true };

	it("没有受保护资源时直接跳过", async () => {
		assert.deepEqual(await resolveTrust({ ...base, override: undefined, hasProtectedResources: false }), {
			trusted: false,
			source: "none",
		});
	});

	it("命令行给出的结论优先于已记录的决定", async () => {
		assert.deepEqual(await resolveTrust({ ...base, override: true }), { trusted: true, source: "flag" });
		assert.deepEqual(await resolveTrust({ ...base, override: false, trustedRoots: [work] }), {
			trusted: false,
			source: "flag",
		});
	});

	it("已记录的决定在命令行没给结论时生效", async () => {
		assert.deepEqual(await resolveTrust({ ...base, override: undefined, trustedRoots: [work] }), {
			trusted: true,
			source: "saved",
		});
	});

	it("没有人可以问时按不信任处理", async () => {
		assert.deepEqual(await resolveTrust({ ...base, override: undefined }), {
			trusted: false,
			source: "default",
		});
	});

	it("有交互界面时按询问的结果定", async () => {
		assert.equal((await resolveTrust({ ...base, override: undefined, ask: () => true })).trusted, true);
		assert.equal((await resolveTrust({ ...base, override: undefined, ask: () => false })).trusted, false);
		assert.equal(
			(await resolveTrust({ ...base, override: undefined, ask: async () => true })).source,
			"asked",
		);
	});
});

describe("把信任结论写回配置", () => {
	/** 从写好的配置里把清单读回来。 */
	function rootsIn(source: string): readonly string[] {
		return readTrustedRoots(new TomlDocument(source).get(["plugins", "trusted"]));
	}

	it("写入清单，并保留原有的注释与排版", () => {
		const file = join(home, "config.toml");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			file,
			[
				"# 我自己的说明",
				'provider = "p"',
				'model = "m"   # 换成别的模型就改这里',
				"",
				"# ── 插件 ──",
				"# [plugins]",
				"# trusted = []",
				"",
			].join("\n"),
		);

		recordTrust(work, true);

		const written = readFileSync(file, "utf8");
		assert.ok(written.includes("# 我自己的说明"));
		assert.ok(written.includes('model = "m"   # 换成别的模型就改这里'));
		assert.ok(written.includes("# ── 插件 ──"));
		assert.ok(written.includes("# [plugins]"));

		assert.deepEqual(rootsIn(written), [resolve(work)]);
	});

	it("取消信任时从清单里去掉", () => {
		mkdirSync(home, { recursive: true });
		recordTrust(work, true);
		recordTrust(work, false);
		assert.deepEqual(rootsIn(readFileSync(join(home, "config.toml"), "utf8")), []);
	});

	it("重复信任同一个目录不会写出两条", () => {
		mkdirSync(home, { recursive: true });
		recordTrust(work, true);
		recordTrust(work, true);
		assert.equal(rootsIn(readFileSync(join(home, "config.toml"), "utf8")).length, 1);
	});

	it("配置文件不存在时新建出来", () => {
		mkdirSync(home, { recursive: true });
		recordTrust(work, true);
		assert.ok(existsSync(join(home, "config.toml")));
	});
});
