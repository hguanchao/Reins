import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { strToU8, zipSync } from "fflate";

import { skillsDir } from "#src/config/paths.ts";
import { discoverSkills } from "#src/skills/discover.ts";
import { installParsedSkill, parseSkillArchive } from "#src/skills/upload.ts";

const created: string[] = [];
const previousHome = process.env["REINS_HOME"];

function home(): string {
	const directory = mkdtempSync(join(tmpdir(), "reins-skill-upload-"));
	created.push(directory);
	process.env["REINS_HOME"] = directory;
	return directory;
}

function archive(files: Record<string, string>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

const SKILL_MD = "---\nname: my-skill\ndescription: 测试技能\n---\n\n# 正文\n";

after(() => {
	if (previousHome === undefined) delete process.env["REINS_HOME"];
	else process.env["REINS_HOME"] = previousHome;
	for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

describe("技能压缩包解析", () => {
	it("认出技能根并保留目录里的其他文件", () => {
		const parsed = parseSkillArchive(
			archive({
				"my-skill/SKILL.md": SKILL_MD,
				"my-skill/scripts/run.sh": "echo hi\n",
				"__MACOSX/my-skill/._SKILL.md": "noise",
			}),
		);

		assert.equal(parsed.name, "my-skill");
		assert.deepEqual([...parsed.files.keys()].sort(), ["SKILL.md", "scripts/run.sh"]);
	});

	it("SKILL.md 在压缩包根目录时也能安装", () => {
		const parsed = parseSkillArchive(archive({ "SKILL.md": SKILL_MD, "notes.txt": "备注" }));
		assert.equal(parsed.name, "my-skill");
		assert.deepEqual([...parsed.files.keys()].sort(), ["SKILL.md", "notes.txt"]);
	});

	it("没有 SKILL.md、多个 SKILL.md、非 zip 都拒绝", () => {
		assert.throws(() => parseSkillArchive(archive({ "readme.md": "没有技能" })), /没有 SKILL.md/);
		assert.throws(
			() =>
				parseSkillArchive(
					archive({
						"a/SKILL.md": "---\nname: a\ndescription: A\n---\n正文",
						"b/SKILL.md": "---\nname: b\ndescription: B\n---\n正文",
					}),
				),
			/只能包含一个技能/,
		);
		assert.throws(() => parseSkillArchive(new Uint8Array([1, 2, 3])), /zip/);
	});

	it("条目数超过上限时拒绝", () => {
		const files: Record<string, string> = { "my-skill/SKILL.md": SKILL_MD };
		for (let index = 0; index < 200; index += 1) {
			files[`my-skill/file-${index}.txt`] = "x";
		}
		assert.throws(() => parseSkillArchive(archive(files)), /条目不能超过/);
	});

	it("路径逃逸与非法 frontmatter 拒绝", () => {
		assert.throws(
			() => parseSkillArchive(archive({ "my-skill/SKILL.md": SKILL_MD, "../escape.txt": "x" })),
			/非法路径/,
		);
		assert.throws(
			() =>
				parseSkillArchive(
					archive({ "my-skill/SKILL.md": "---\nname: Bad Name\ndescription: d\n---\n正文" }),
				),
			/合法名称/,
		);
		assert.throws(
			() =>
				parseSkillArchive(
					archive({ "my-skill/SKILL.md": "---\nname: my-skill\n---\n正文" }),
				),
			/描述/,
		);
	});
});

describe("技能压缩包安装", () => {
	it("安装到用户级技能目录，并能被技能发现读到", () => {
		home();
		const parsed = parseSkillArchive(
			archive({ "my-skill/SKILL.md": SKILL_MD, "my-skill/scripts/run.sh": "echo hi\n" }),
		);
		installParsedSkill(parsed);

		const directory = join(skillsDir(), "my-skill");
		assert.equal(readFileSync(join(directory, "SKILL.md"), "utf8"), SKILL_MD);
		assert.equal(readFileSync(join(directory, "scripts", "run.sh"), "utf8"), "echo hi\n");
		assert.deepEqual(
			discoverSkills([{ directory: skillsDir(), scope: "user" }]).map((skill) => skill.name),
			["my-skill"],
		);
	});

	it("同名技能已存在时拒绝，不覆盖原内容", () => {
		home();
		const parsed = parseSkillArchive(archive({ "my-skill/SKILL.md": SKILL_MD }));
		installParsedSkill(parsed);
		assert.throws(() => installParsedSkill(parsed), /已存在/);
		assert.equal(readFileSync(join(skillsDir(), "my-skill", "SKILL.md"), "utf8"), SKILL_MD);
		assert.equal(existsSync(join(skillsDir(), ".my-skill")), false);
	});
});
