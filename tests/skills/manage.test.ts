import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { skillsDir } from "#src/config/paths.ts";
import { createUserSkill, createUserSkillFromContent } from "#src/skills/create.ts";
import { discoverSkills, type SkillInfo } from "#src/skills/discover.ts";
import {
	deleteUserSkill,
	isEditableSkill,
	readSkillContent,
	updateUserSkill,
} from "#src/skills/manage.ts";

const created: string[] = [];
const previousHome = process.env["REINS_HOME"];

function home(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-skill-manage-"));
	created.push(directory);
	process.env["REINS_HOME"] = directory;
	return directory;
}

function userSkills(): readonly SkillInfo[] {
	return discoverSkills([{ directory: skillsDir(), scope: "user" }]);
}

function outsideSkill(): SkillInfo {
	const directory = mkdtempSync(join(tmpdir(), "reins-skill-outside-"));
	created.push(directory);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "SKILL.md");
	writeFileSync(path, "---\nname: outside\ndescription: 外部\n---\n\n正文\n", "utf8");
	return { name: "outside", description: "外部", path, scope: "user", directory };
}

after(() => {
	if (previousHome === undefined) delete process.env["REINS_HOME"];
	else process.env["REINS_HOME"] = previousHome;
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("技能读取", () => {
	it("返回 description 与正文", () => {
		home();
		createUserSkill({ name: "writer", description: "写文档", content: "# 步骤\n\n写正文" });
		const skill = userSkills()[0];
		assert.ok(skill);
		const content = readSkillContent(skill);
		assert.equal(content.name, "writer");
		assert.equal(content.description, "写文档");
		assert.equal(content.content, "# 步骤\n\n写正文");
	});
});

describe("技能更新", () => {
	it("只替换 description 与正文，保留额外 frontmatter", () => {
		home();
		createUserSkillFromContent(
			"writer",
			"---\nname: writer\ndescription: >\n  old text\nlicense: MIT\n---\n\nold body\n",
		);
		const skill = userSkills()[0];
		assert.ok(skill);
		assert.equal(readSkillContent(skill).description, "old text");

		updateUserSkill(skill, { name: "writer", description: "new text", content: "new body" });

		const text = readFileSync(skill.path, "utf8");
		assert.match(text, /name: writer/);
		assert.match(text, /description: new text/);
		assert.match(text, /license: MIT/);
		assert.match(text, /new body/);
		assert.doesNotMatch(text, /old text/);
		assert.doesNotMatch(text, /description: >/);
	});

	it("名称不可修改", () => {
		home();
		createUserSkill({ name: "writer", description: "写文档", content: "正文" });
		const skill = userSkills()[0];
		assert.ok(skill);
		assert.throws(
			() => updateUserSkill(skill, { name: "other", description: "x", content: "y" }),
			/名称不可修改/,
		);
	});

	it("项目技能与技能目录之外的路径都拒绝", () => {
		home();
		const project: SkillInfo = {
			...outsideSkill(),
			scope: "project",
		};
		assert.equal(isEditableSkill(project), false);
		assert.throws(
			() => updateUserSkill(project, { name: "outside", description: "x", content: "y" }),
			/只读/,
		);

		const outside = outsideSkill();
		assert.equal(isEditableSkill(outside), false);
		assert.throws(
			() => updateUserSkill(outside, { name: "outside", description: "x", content: "y" }),
			/只读/,
		);
	});
});

describe("技能删除", () => {
	it("删除技能目录", () => {
		home();
		createUserSkill({ name: "temp", description: "临时", content: "正文" });
		const skill = userSkills()[0];
		assert.ok(skill);
		deleteUserSkill(skill);
		assert.equal(existsSync(skill.directory), false);
		assert.deepEqual(userSkills(), []);
	});
});
