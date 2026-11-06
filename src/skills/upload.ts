import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

import { configDir, skillsDir } from "#src/config/paths.ts";
import { isPathInside } from "#src/workspace/boundary.ts";
import { MAX_CONTENT_BYTES, MAX_DESCRIPTION_CHARS, SKILL_NAME } from "#src/skills/draft.ts";
import { parseSkillFrontmatter } from "#src/skills/discover.ts";

/**
 * 技能压缩包安装。
 *
 * 压缩包是外部输入：路径、条目数、解压后体积都要先收紧，否则一个 zip 就能把技能目录写成
 * 任意路径或撑爆内存。安装先写临时目录再改名，中途失败不会留下半个技能。
 */

/** 上传体积上限；界面与服务端共用这个口径。 */
export const MAX_SKILL_ARCHIVE_BYTES = 5 * 1024 * 1024;

const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKILL_FILE = "SKILL.md";

export interface SkillArchive {
	readonly name: string;
	/** 相对技能根的文件路径 → 内容；至少包含 SKILL.md */
	readonly files: ReadonlyMap<string, Uint8Array>;
}

/** 解析压缩包并校验 frontmatter；不落盘。 */
export function parseSkillArchive(archive: Uint8Array): SkillArchive {
	if (archive.length < 2 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
		throw new Error("请选择 zip 压缩包");
	}

	let entries = 0;
	let totalBytes = 0;
	const unpacked = unzipSync(archive, {
		filter: (file) => {
			if (file.name.endsWith("/")) return false;
			if (isNoise(file.name)) return false;
			entries += 1;
			if (entries > MAX_ENTRIES) throw new Error(`压缩包条目不能超过 ${MAX_ENTRIES} 个`);
			if (file.originalSize > MAX_FILE_BYTES) {
				throw new Error(`单个文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
			}
			totalBytes += file.originalSize;
			if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
				throw new Error(`解压后总大小不能超过 ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB`);
			}
			return true;
		},
	});

	const files = new Map<string, Uint8Array>();
	for (const [rawName, data] of Object.entries(unpacked)) {
		const name = normalizeEntry(rawName);
		if (name.length === 0) continue;
		if (files.has(name)) throw new Error(`压缩包包含重复路径：${name}`);
		files.set(name, data);
	}

	const skillFiles = [...files.keys()].filter(
		(name) => name === SKILL_FILE || name.endsWith(`/${SKILL_FILE}`),
	);
	if (skillFiles.length === 0) throw new Error("压缩包内没有 SKILL.md");
	if (skillFiles.length > 1) throw new Error("压缩包内只能包含一个技能（一个 SKILL.md）");

	const skillFile = skillFiles[0];
	if (skillFile === undefined) throw new Error("压缩包内没有 SKILL.md");
	const prefix = skillFile === SKILL_FILE ? "" : skillFile.slice(0, -SKILL_FILE.length);
	const relativeFiles = new Map<string, Uint8Array>();
	for (const [name, data] of files) {
		if (prefix.length > 0 && !name.startsWith(prefix)) continue;
		const relativePath = prefix.length === 0 ? name : name.slice(prefix.length);
		if (relativePath.length === 0) continue;
		relativeFiles.set(relativePath, data);
	}

	const skillMd = relativeFiles.get(SKILL_FILE);
	if (skillMd === undefined) throw new Error("压缩包内没有 SKILL.md");
	if (skillMd.length > MAX_CONTENT_BYTES) {
		throw new Error(`SKILL.md 不能超过 ${MAX_CONTENT_BYTES / 1024} KB`);
	}
	const content = new TextDecoder("utf-8")
		.decode(skillMd)
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n");
	const front = parseSkillFrontmatter(content);
	if (front.name === undefined || !SKILL_NAME.test(front.name)) {
		throw new Error("SKILL.md 需要在 frontmatter 中提供合法名称（小写字母、数字、- 和 _）");
	}
	const description = front.description?.trim() ?? "";
	if (description.length === 0) {
		throw new Error("SKILL.md 需要在 frontmatter 中提供描述");
	}
	if (/[\r\n]/.test(description)) throw new Error("SKILL.md 的描述只能是一行");
	if (description.length > MAX_DESCRIPTION_CHARS) {
		throw new Error(`描述不能超过 ${MAX_DESCRIPTION_CHARS} 个字符`);
	}

	return { name: front.name, files: relativeFiles };
}

/** 安装到用户级技能目录；同名技能已存在时拒绝。 */
export function installParsedSkill(parsed: SkillArchive): { readonly path: string } {
	const { name, files } = parsed;
	if (!files.has(SKILL_FILE)) throw new Error("压缩包内没有 SKILL.md");
	const root = skillsDir();
	const target = join(root, name);
	if (existsSync(target)) throw new Error(`技能 ${name} 已存在`);

	mkdirSync(root, { recursive: true });
	// 临时目录放在技能目录之外：进程中途崩溃时残留不会被技能发现当成一个技能。
	// 随机后缀让并发上传同名技能不会撞车。
	mkdirSync(configDir(), { recursive: true });
	const temporary = join(
		configDir(),
		`.skill-upload-${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	mkdirSync(temporary);
	try {
		for (const [relativePath, data] of files) {
			const path = join(temporary, ...relativePath.split("/"));
			if (!isPathInside(temporary, path)) {
				throw new Error(`压缩包包含非法路径：${relativePath}`);
			}
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data);
		}
		try {
			renameSync(temporary, target);
		} catch (error) {
			if (existsSync(target)) throw new Error(`技能 ${name} 已存在`);
			throw error;
		}
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
	return { path: join(target, SKILL_FILE) };
}

/** macOS 打包常带 __MACOSX 与 .DS_Store；它们不是技能内容。 */
function isNoise(name: string): boolean {
	const normalized = name.replace(/\\/g, "/");
	return normalized.startsWith("__MACOSX/") || normalized.endsWith("/.DS_Store") || normalized === ".DS_Store";
}

/** zip 内路径统一成 `/` 分隔的相对路径；绝对路径与 .. 一律拒绝。 */
function normalizeEntry(name: string): string {
	const normalized = name.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (normalized.length === 0 || normalized.endsWith("/")) return "";
	if (/[\u0000-\u001f]/.test(normalized)) {
		throw new Error(`压缩包包含非法路径：${name}`);
	}
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
		throw new Error(`压缩包包含非法路径：${name}`);
	}
	const parts = normalized.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
		throw new Error(`压缩包包含非法路径：${name}`);
	}
	return parts.join("/");
}
