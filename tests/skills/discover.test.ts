import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	defaultSkillRoots,
	discoverSkills,
	type SkillRoot,
	type SkillScope,
} from "../../src/skills/discover.ts";

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

function rootsOf(
	...entries: readonly (string | readonly [string, SkillScope])[]
): readonly SkillRoot[] {
	return entries.map((entry) =>
		typeof entry === "string"
			? { directory: entry, scope: "user" as const }
			: { directory: entry[0], scope: entry[1] },
	);
}

after(() => {
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("技能发现", () => {
	it("目录不存在时当作没有技能", () => {
		assert.deepEqual(discoverSkills(rootsOf(join(tempRoot(), "missing"))), []);
	});

	it("读出 frontmatter 里的名称与说明，并带上 SKILL.md 的路径", () => {
		const root = tempRoot();
		const directory = writeSkill(
			root,
			"alpha",
			["---", "name: writer", "description: 把改动整理成文档", "---", "", "# 正文"].join("\n"),
		);

		assert.deepEqual(discoverSkills(rootsOf(root)), [
			{
				name: "writer",
				description: "把改动整理成文档",
				path: join(directory, "SKILL.md"),
				scope: "user",
				directory,
			},
		]);
	});

	it("没有 frontmatter 时名称退回目录名", () => {
		const root = tempRoot();
		writeSkill(root, "plain", "# 只有正文\n");

		const skills = discoverSkills(rootsOf(root));
		assert.equal(skills.length, 1);
		assert.equal(skills[0]?.name, "plain");
		assert.equal(skills[0]?.description, "");
	});

	it("缺少收尾的 --- 时整段作废，名称仍取目录名", () => {
		const root = tempRoot();
		writeSkill(root, "unclosed", ["---", "name: never-used", "description: 也不算"].join("\n"));

		assert.equal(discoverSkills(rootsOf(root))[0]?.name, "unclosed");
	});

	it("去掉成对的引号", () => {
		const root = tempRoot();
		writeSkill(root, "quoted", ["---", 'name: "带 空格"', "description: '单引号'", "---"].join("\n"));

		assert.deepEqual(
			discoverSkills(rootsOf(root)).map((skill) => [skill.name, skill.description]),
			[["带 空格", "单引号"]],
		);
	});

	it("没有 SKILL.md 的子目录不算技能", () => {
		const root = tempRoot();
		mkdirSync(join(root, "empty"), { recursive: true });

		assert.deepEqual(discoverSkills(rootsOf(root)), []);
	});

	it("块标量写法也能读出说明：> 折成一行，| 保留换行", () => {
		const root = tempRoot();
		writeSkill(
			root,
			"folded",
			["---", "name: folded", "description: >", "  第一行", "  第二行", "---"].join("\n"),
		);
		writeSkill(
			root,
			"literal",
			["---", "name: literal", "description: |", "  第一行", "  第二行", "---"].join("\n"),
		);

		assert.deepEqual(
			discoverSkills(rootsOf(root)).map((skill) => [skill.name, skill.description]),
			[
				["folded", "第一行 第二行"],
				["literal", "第一行\n第二行"],
			],
		);
	});

	it("块标量之后的键仍然生效", () => {
		const root = tempRoot();
		writeSkill(root, "dir", ["---", "description: >", "  说明", "name: after-block", "---"].join("\n"));

		const skill = discoverSkills(rootsOf(root))[0];
		assert.equal(skill?.name, "after-block");
		assert.equal(skill?.description, "说明");
	});

	it("按名称排序，而不是按目录名", () => {
		const root = tempRoot();
		writeSkill(root, "z-directory", ["---", "name: alpha", "---"].join("\n"));
		writeSkill(root, "a-directory", ["---", "name: zeta", "---"].join("\n"));

		assert.deepEqual(
			discoverSkills(rootsOf(root)).map((skill) => skill.name),
			["alpha", "zeta"],
		);
	});

	it("多个根合并成一份清单", () => {
		const userRoot = tempRoot();
		const projectRoot = tempRoot();
		writeSkill(userRoot, "writer", ["---", "name: writer", "---"].join("\n"));
		writeSkill(projectRoot, "reviewer", ["---", "name: reviewer", "---"].join("\n"));

		const skills = discoverSkills(rootsOf([userRoot, "user"], [projectRoot, "project"]));
		assert.deepEqual(
			skills.map((skill) => [skill.name, skill.scope]),
			[
				["reviewer", "project"],
				["writer", "user"],
			],
		);
	});

	it("同名时项目级覆盖用户级", () => {
		const userRoot = tempRoot();
		const projectRoot = tempRoot();
		writeSkill(userRoot, "writer", ["---", "name: writer", "description: 用户版", "---"].join("\n"));
		writeSkill(projectRoot, "writer", ["---", "name: writer", "description: 项目版", "---"].join("\n"));

		const skills = discoverSkills(rootsOf([userRoot, "user"], [projectRoot, "project"]));
		assert.equal(skills.length, 1);
		assert.equal(skills[0]?.description, "项目版");
		assert.equal(skills[0]?.scope, "project");
	});

	it("根的顺序不影响项目级优先", () => {
		const userRoot = tempRoot();
		const projectRoot = tempRoot();
		writeSkill(userRoot, "writer", ["---", "name: writer", "description: 用户版", "---"].join("\n"));
		writeSkill(projectRoot, "writer", ["---", "name: writer", "description: 项目版", "---"].join("\n"));

		const skills = discoverSkills(rootsOf([projectRoot, "project"], [userRoot, "user"]));
		assert.equal(skills[0]?.description, "项目版");
	});

	it("默认根：用户级总是两根，项目级只在受信任时加进来", () => {
		const untrusted = defaultSkillRoots("/repo", false);
		assert.deepEqual(
			untrusted.map((root) => root.scope),
			["user", "user"],
		);
		// 用户级两根：Reins 自己的目录 + 跨工具的 .agents/skills
		assert.ok(untrusted.some((root) => root.directory.endsWith(join(".agents", "skills"))));

		const trusted = defaultSkillRoots("/repo", true);
		assert.deepEqual(
			trusted.map((root) => root.scope),
			["user", "user", "project", "project"],
		);
		assert.deepEqual(
			trusted.slice(2).map((root) => root.directory),
			[join("/repo", ".reins", "skills"), join("/repo", ".agents", "skills")],
		);
	});

	it("single 根：目录本身就是技能，不再往下扫一层", () => {
		const parent = tempRoot();
		const single = writeSkill(parent, "pdf", ["---", "name: pdf", "description: 处理 PDF", "---"].join("\n"));

		// 同一个目录按父目录扫会找 pdf/SKILL.md 而落空，按 single 扫才能读出技能
		assert.deepEqual(discoverSkills([{ directory: single, scope: "user" }]), []);
		assert.deepEqual(discoverSkills([{ directory: single, scope: "user", single: true }]), [
			{
				name: "pdf",
				description: "处理 PDF",
				path: join(single, "SKILL.md"),
				scope: "user",
				directory: single,
			},
		]);
	});

	it("single 根缺少 SKILL.md 时什么都不返回", () => {
		assert.deepEqual(
			discoverSkills([{ directory: join(tempRoot(), "empty"), scope: "user", single: true }]),
			[],
		);
	});
});
