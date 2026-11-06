/**
 * 技能表单校验。
 *
 * 技能目录名同时是技能标识；限制字符集既是为了路径安全，也是为了让模型看到的技能名稳定。
 * 编辑只改描述与正文，名称不参与改写。
 */

export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_CONTENT_BYTES = 64 * 1024;

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
