import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { skillsDir } from "#src/config/paths.ts";
import { parseSkillFrontmatter } from "#src/skills/discover.ts";

/**
 * 新建用户级技能。
 *
 * 技能是 `<配置目录>/skills/<名称>/SKILL.md`；目录名同时是技能标识，限制字符集既是为了
 * 路径安全，也是为了让模型看到的技能名稳定。目录已存在时拒绝而不是覆盖：里面可能已经有
 * 使用者手写的正文。
 */

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_CONTENT_BYTES = 64 * 1024;

export interface SkillDraft {
	readonly name: string;
	readonly description: string;
	readonly content: string;
}

export interface SkillDraftResult {
	readonly ok: boolean;
	readonly draft?: SkillDraft;
	readonly error?: string;
}

/** 校验界面传来的技能表单；返回收窄后的值，供写盘与测试共用。 */
export function parseSkillDraft(body: Record<string, unknown>): SkillDraftResult {
	const rawName = body["name"];
	if (typeof rawName !== "string" || rawName.trim().length === 0) {
		return { ok: false, error: "请填写名称" };
	}
	const name = rawName.trim();
	if (!SKILL_NAME.test(name)) {
		return { ok: false, error: "名称只能使用小写字母、数字、- 和 _" };
	}

	const rawDescription = body["description"];
	if (typeof rawDescription !== "string") {
		return { ok: false, error: "请填写描述" };
	}
	const description = rawDescription.trim();
	if (description.length === 0) {
		return { ok: false, error: "请填写描述" };
	}
	if (/[\r\n]/.test(description)) {
		return { ok: false, error: "描述只能是一行" };
	}
	if (description.length > MAX_DESCRIPTION_CHARS) {
		return { ok: false, error: `描述不能超过 ${MAX_DESCRIPTION_CHARS} 个字符` };
	}

	const rawContent = body["content"];
	if (typeof rawContent !== "string") {
		return { ok: false, error: "请填写指令正文" };
	}
	const content = rawContent.trim();
	if (content.length === 0) {
		return { ok: false, error: "请填写指令正文" };
	}
	if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
		return { ok: false, error: `指令正文不能超过 ${MAX_CONTENT_BYTES / 1024} KB` };
	}

	return { ok: true, draft: { name, description, content } };
}

/** 写入 SKILL.md；目录创建失败时不留下半份技能。 */
export function createUserSkill(draft: SkillDraft): { readonly path: string } {
	return writeSkill(
		draft.name,
		`---\nname: ${draft.name}\ndescription: ${draft.description}\n---\n\n${draft.content}\n`,
	);
}

export interface SkillUploadDraft {
	readonly name: string;
	readonly content: string;
}

export interface SkillUploadResult {
	readonly ok: boolean;
	readonly draft?: SkillUploadDraft;
	readonly error?: string;
}

/** 校验上传的 SKILL.md：必须自带 name 与 description frontmatter，正文原样保存。 */
export function parseSkillUpload(body: Record<string, unknown>): SkillUploadResult {
	const raw = body["content"];
	if (typeof raw !== "string") return { ok: false, error: "请选择 SKILL.md 文件" };
	const content = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
	if (content.length === 0) return { ok: false, error: "请选择 SKILL.md 文件" };
	if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
		return { ok: false, error: `SKILL.md 不能超过 ${MAX_CONTENT_BYTES / 1024} KB` };
	}

	const front = parseSkillFrontmatter(content);
	if (front.name === undefined || !SKILL_NAME.test(front.name)) {
		return {
			ok: false,
			error: "上传的 SKILL.md 需要在 frontmatter 中提供合法名称（小写字母、数字、- 和 _）",
		};
	}
	if (front.description === undefined || front.description.trim().length === 0) {
		return { ok: false, error: "上传的 SKILL.md 需要在 frontmatter 中提供描述" };
	}
	return { ok: true, draft: { name: front.name, content } };
}

/** 上传的技能保留原始 frontmatter，只补齐结尾换行。 */
export function createUserSkillFromContent(name: string, content: string): { readonly path: string } {
	return writeSkill(name, content.endsWith("\n") ? content : `${content}\n`);
}

function writeSkill(name: string, text: string): { readonly path: string } {
	const root = skillsDir();
	const directory = join(root, name);
	mkdirSync(root, { recursive: true });
	try {
		mkdirSync(directory);
	} catch (error) {
		if (isAlreadyExists(error)) throw new Error(`技能 ${name} 已存在`);
		throw error;
	}

	const path = join(directory, "SKILL.md");
	try {
		writeFileSync(path, text, "utf8");
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	return { path };
}

function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "EEXIST"
	);
}
