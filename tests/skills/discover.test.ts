import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { discoverSkills } from "../../src/skills/discover.ts";

const created: string[] = [];

function tempRoot(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-skills-"));
	created.push(directory);
	return directory;
}

/** 建一个技能目录并写入 SKILL.md */
function writeSkill(root: string, name: string, contents: string): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), contents, "utf8");
	return directory;
}

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("技能发现", () => {
	it("目录不存在时当作没有技能", () => {
		assert.deepEqual(discoverSkills(join(tempRoot(), "missing")), []);
	});

	it("读出 frontmatter 里的名称与说明", () => {
		const root = tempRoot();
		const directory = writeSkill(
			root,
			"alpha",
			["---", "name: writer", "description: 把改动整理成文档", "---", "", "# 正文"].join("\n"),
		);

		assert.deepEqual(discoverSkills(root), [
			{ name: "writer", description: "把改动整理成文档", directory },
		]);
	});

	it("没有 frontmatter 时名称退回目录名", () => {
		const root = tempRoot();
		writeSkill(root, "plain", "# 只有正文\n");

		const skills = discoverSkills(root);
		assert.equal(skills.length, 1);
		assert.equal(skills[0]?.name, "plain");
		assert.equal(skills[0]?.description, "");
	});

	it("缺少收尾的 --- 时整段作废，名称仍取目录名", () => {
		const root = tempRoot();
		writeSkill(root, "unclosed", ["---", "name: never-used", "description: 也不算"].join("\n"));

		assert.equal(discoverSkills(root)[0]?.name, "unclosed");
	});

	it("去掉成对的引号", () => {
		const root = tempRoot();
		writeSkill(root, "quoted", ["---", 'name: "带 空格"', "description: '单引号'", "---"].join("\n"));

		assert.deepEqual(
			discoverSkills(root).map((skill) => [skill.name, skill.description]),
			[["带 空格", "单引号"]],
		);
	});

	it("没有 SKILL.md 的子目录不算技能", () => {
		const root = tempRoot();
		mkdirSync(join(root, "empty"), { recursive: true });

		assert.deepEqual(discoverSkills(root), []);
	});

	it("按名称排序，而不是按目录名", () => {
		const root = tempRoot();
		writeSkill(root, "z-directory", ["---", "name: alpha", "---"].join("\n"));
		writeSkill(root, "a-directory", ["---", "name: zeta", "---"].join("\n"));

		assert.deepEqual(
			discoverSkills(root).map((skill) => skill.name),
			["alpha", "zeta"],
		);
	});
});
