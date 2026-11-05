import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { skillsDir } from "#src/config/paths.ts";
import {
	createUserSkill,
	createUserSkillFromContent,
	parseSkillDraft,
	parseSkillUpload,
} from "#src/skills/create.ts";
import { discoverSkills } from "#src/skills/discover.ts";

const created: string[] = [];
const previousHome = process.env["REINS_HOME"];

function home(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-skill-create-"));
	created.push(directory);
	process.env["REINS_HOME"] = directory;
	return directory;
}

after(() => {
	if (previousHome === undefined) delete process.env["REINS_HOME"];
	else process.env["REINS_HOME"] = previousHome;
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("技能表单校验", () => {
	it("接受合法的名称、单行描述与正文", () => {
		const result = parseSkillDraft({
			name: "release-notes",
			description: "按提交记录整理发布说明",
			content: "# 步骤\n\n1. 读取提交\n2. 归纳变更",
		});
		assert.equal(result.ok, true);
		assert.deepEqual(result.draft, {
			name: "release-notes",
			description: "按提交记录整理发布说明",
			content: "# 步骤\n\n1. 读取提交\n2. 归纳变更",
		});
	});

	it("拒绝非法名称、多行描述与空正文", () => {
		assert.equal(parseSkillDraft({ name: "../escape", description: "d", content: "c" }).ok, false);
		assert.equal(parseSkillDraft({ name: "Bad Name", description: "d", content: "c" }).ok, false);
		assert.equal(parseSkillDraft({ name: "ok", description: "a\nb", content: "c" }).ok, false);
		assert.equal(parseSkillDraft({ name: "ok", description: "d", content: "  " }).ok, false);
	});
});

describe("创建用户级技能", () => {
	it("写入带 frontmatter 的 SKILL.md，并能被技能发现读到", () => {
		home();
		const result = createUserSkill({
			name: "release-notes",
			description: "按提交记录整理发布说明",
			content: "# 步骤\n\n读取提交并归纳。",
		});

		assert.equal(result.path, join(skillsDir(), "release-notes", "SKILL.md"));
		const text = readFileSync(result.path, "utf8");
		assert.match(text, /^---\nname: release-notes\ndescription: 按提交记录整理发布说明\n---\n\n# 步骤/);

		const skills = discoverSkills([{ directory: skillsDir(), scope: "user" }]);
		assert.deepEqual(
			skills.map((skill) => [skill.name, skill.description, skill.scope]),
			[["release-notes", "按提交记录整理发布说明", "user"]],
		);
	});

	it("同名目录已存在时拒绝，不覆盖原内容", () => {
		home();
		createUserSkill({ name: "writer", description: "写文档", content: "原内容" });
		assert.throws(
			() => createUserSkill({ name: "writer", description: "新描述", content: "新内容" }),
			/已存在/,
		);
		assert.match(
			readFileSync(join(skillsDir(), "writer", "SKILL.md"), "utf8"),
			/原内容/,
		);
	});
});

describe("上传 SKILL.md", () => {
	const document = `---
name: uploaded
description: 上传的技能
license: MIT
---

# 正文

按步骤执行。
`;

	it("校验 frontmatter 并原样写入正文与附加字段", () => {
		home();
		const parsed = parseSkillUpload({ content: document });
		assert.equal(parsed.ok, true);
		const draft = parsed.draft;
		assert.ok(draft);
		assert.equal(draft.name, "uploaded");

		const result = createUserSkillFromContent(draft.name, draft.content);
		const text = readFileSync(result.path, "utf8");
		assert.match(text, /license: MIT/);
		assert.match(text, /# 正文/);

		const skills = discoverSkills([{ directory: skillsDir(), scope: "user" }]);
		assert.deepEqual(
			skills.map((skill) => [skill.name, skill.description]),
			[["uploaded", "上传的技能"]],
		);
	});

	it("缺少 frontmatter、名称或描述时拒绝", () => {
		assert.equal(parseSkillUpload({ content: "# 只有正文" }).ok, false);
		assert.equal(
			parseSkillUpload({ content: "---\ndescription: 描述\n---\n正文" }).ok,
			false,
		);
		assert.equal(
			parseSkillUpload({ content: "---\nname: Uploaded Name\ndescription: 描述\n---\n正文" }).ok,
			false,
		);
		assert.equal(
			parseSkillUpload({ content: "---\nname: uploaded\n---\n正文" }).ok,
			false,
		);
	});
});
