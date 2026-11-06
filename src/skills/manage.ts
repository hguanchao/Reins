import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

import { skillsDir } from "#src/config/paths.ts";
import { isPathInside, resolveRealPath } from "#src/workspace/boundary.ts";
import type { SkillDraft } from "#src/skills/draft.ts";
import { parseSkillFrontmatter, type SkillInfo } from "#src/skills/discover.ts";

/**
 * 用户技能的读取、编辑与删除。
 *
 * 只有 `<配置目录>/skills` 下的技能可写：项目技能属于仓库，`.agents` 与 `.dsh` 是其他工具
 * 共用的位置，从 Reins 里改它们会越界。判定用真实路径而不是字面路径，目录链接指到根外时
 * 一样拒绝。
 */

const MAX_SKILL_BYTES = 64 * 1024;

/** 可编辑 = 用户级 + 真实路径落在 Reins 自己的技能目录内。 */
export function isEditableSkill(skill: SkillInfo): boolean {
	if (skill.scope !== "user") return false;
	try {
		const root = resolveRealPath(skillsDir());
		const directory = resolveRealPath(skill.directory);
		const path = resolveRealPath(skill.path);
		return directory !== root && isPathInside(root, directory) && isPathInside(root, path);
	} catch {
		return false;
	}
}

/** 读取 SKILL.md 的 description 与正文；名称以发现结果为准，避免同名覆盖时指错文件。 */
export function readSkillContent(skill: SkillInfo): {
	readonly name: string;
	readonly description: string;
	readonly content: string;
} {
	assertEditable(skill);
	const raw = readSkillFile(skill.path);
	const document = splitDocument(raw);
	return {
		name: skill.name,
		description: document.description ?? skill.description,
		content: document.body,
	};
}

/**
 * 更新一个用户技能。
 *
 * 名称不可改：目录名就是技能标识，改名等于换一个技能，还会与同名技能、目录占用纠缠。
 * 只替换 description 与正文，frontmatter 里的其他键（license、allowed-tools 等）原样保留。
 */
export function updateUserSkill(skill: SkillInfo, draft: SkillDraft): { readonly path: string } {
	assertEditable(skill);
	if (draft.name !== skill.name) {
		throw new Error("技能名称不可修改");
	}
	const raw = readSkillFile(skill.path);
	const next = replaceDocument(raw, draft.name, draft.description, draft.content);
	writeAtomic(skill.path, next);
	return { path: skill.path };
}

/** 删除技能目录；只允许删 Reins 自己技能目录下的用户技能。 */
export function deleteUserSkill(skill: SkillInfo): void {
	assertEditable(skill);
	rmSync(skill.directory, { recursive: true, force: true });
}

function assertEditable(skill: SkillInfo): void {
	if (!isEditableSkill(skill)) throw new Error(`技能 ${skill.name} 是只读的`);
}

function readSkillFile(path: string): string {
	const size = statSync(path).size;
	if (size > MAX_SKILL_BYTES) {
		throw new Error(`SKILL.md 不能超过 ${MAX_SKILL_BYTES / 1024} KB`);
	}
	return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

interface SkillDocument {
	/** frontmatter 内除围栏外的原始行；没有 frontmatter 时是 undefined */
	readonly frontmatter: readonly string[] | undefined;
	readonly description: string | undefined;
	readonly body: string;
}

/** 按 SKILL.md 的围栏切出 frontmatter 与正文；围栏缺失时整份都算正文。 */
function splitDocument(raw: string): SkillDocument {
	const text = raw.replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	let start = 0;
	while (start < lines.length && lines[start].trim().length === 0) start += 1;
	if (lines[start]?.trim() !== "---") {
		return { frontmatter: undefined, description: undefined, body: text.trim() };
	}

	let end = -1;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			end = index;
			break;
		}
	}
	if (end === -1) {
		return { frontmatter: undefined, description: undefined, body: text.trim() };
	}

	return {
		frontmatter: lines.slice(start + 1, end),
		description: parseSkillFrontmatter(text).description,
		body: lines.slice(end + 1).join("\n").trim(),
	};
}

/** 保留未知 frontmatter 键，只换 description 与正文。 */
function replaceDocument(
	raw: string,
	name: string,
	description: string,
	content: string,
): string {
	const document = splitDocument(raw);
	const body = content.trim();
	if (document.frontmatter === undefined) {
		return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
	}

	const lines = [...document.frontmatter];
	const index = lines.findIndex((line) => /^\s*description\s*:/.test(line));
	if (index === -1) {
		const nameIndex = lines.findIndex((line) => /^\s*name\s*:/.test(line));
		lines.splice(nameIndex === -1 ? 0 : nameIndex + 1, 0, `description: ${description}`);
	} else {
		// 块标量（> / |）的续行都缩进；连同这些行一起换掉，不能只改第一行
		const block = /:\s*[>|][+-]?\s*$/.test(lines[index]) || /:\s*$/.test(lines[index]);
		if (block) {
			let end = index + 1;
			while (end < lines.length && (lines[end].trim().length === 0 || /^\s/.test(lines[end]))) {
				end += 1;
			}
			lines.splice(index, end - index, `description: ${description}`);
		} else {
			lines.splice(index, 1, `description: ${description}`);
		}
	}

	return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

/** 先写临时文件再改名；写到一半失败不会把唯一一份 SKILL.md 截断。 */
function writeAtomic(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, text, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
