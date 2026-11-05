import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { configDir, projectInstructionFiles, userInstructionFiles } from "#src/config/paths.ts";

/**
 * 规则文件（AGENTS.md）的发现与读取。
 *
 * 用户级规则总是读取；项目级规则会进入系统提示词，因此与项目配置、项目技能一样要求工作区
 * 信任。同一目录里 `AGENTS.override.md` 存在时取代 `AGENTS.md` / `CLAUDE.md`。
 * 只读工作区根目录：Reins 的工作边界就是这里，不越过它去读父目录。
 */

/** 规则文件的总字节预算；超出后截断并明确告诉模型，避免一份大文件撑爆系统提示词。 */
export const MAX_INSTRUCTION_BYTES = 32 * 1024;

/** 一条待读取的规则来源；label 只用于提示词里标明出处。 */
interface InstructionSource {
	readonly label: string;
	readonly path: string;
}

/** 已经读进内存的规则正文。 */
export interface PromptInstruction {
	readonly label: string;
	readonly text: string;
}

/** 发现当前可用的用户级与项目级规则文件；项目级是否读取由工作区信任决定。 */
export function defaultInstructionSources(
	workRoot: string,
	trusted: boolean,
): readonly InstructionSource[] {
	const sources: InstructionSource[] = [];
	const user = pickInstructionFile(userInstructionFiles());
	if (user !== undefined) sources.push({ label: userLabel(user), path: user });

	if (trusted) {
		const project = pickInstructionFile(projectInstructionFiles(workRoot));
		if (project !== undefined) sources.push({ label: basename(project), path: project });
	}
	return sources;
}

/** override 优先；没有它时按 AGENTS.md、CLAUDE.md 的顺序取第一个存在的文件。 */
function pickInstructionFile(candidates: readonly string[]): string | undefined {
	const [override, ...fallbacks] = candidates;
	if (override !== undefined && isFile(override)) return override;
	return fallbacks.find(isFile);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** 用户级路径缩写成 `~`，提示词里不必展开整个主目录。 */
function userLabel(path: string): string {
	const home = homedir();
	const rest = path.startsWith(home) ? path.slice(home.length) : undefined;
	const label =
		rest !== undefined && (rest.startsWith("\\") || rest.startsWith("/"))
			? `~${rest}`
			: path;
	return label.replaceAll("\\", "/");
}

/** 读取上限：编辑页要一次显示全文，这里给一个远高于预算的硬上限，避免误读超大文件。 */
const MAX_PERSONALIZATION_READ_BYTES = 1024 * 1024;

/** 个性化指令的落盘文件：优先写当前生效的用户规则文件，都没有时新建 AGENTS.md。 */
export function personalizationPath(): string {
	const file = pickInstructionFile(userInstructionFiles());
	if (file !== undefined) return file;
	return join(configDir(), "AGENTS.md");
}

export interface PersonalizationText {
	readonly path: string;
	readonly text: string;
	readonly bytes: number;
	/** 系统提示词对规则文件的总预算；超过后模型只能读到截断内容 */
	readonly maxBytes: number;
}

/** 读取个性化指令原文；文件不存在时返回空内容。 */
export function readPersonalization(): PersonalizationText {
	const path = personalizationPath();
	let text = "";
	if (existsSync(path)) {
		const info = statSync(path);
		if (!info.isFile()) throw new Error(`个性化指令路径不是文件：${path}`);
		if (info.size > MAX_PERSONALIZATION_READ_BYTES) {
			throw new Error("个性化指令文件过大，无法在界面中编辑");
		}
		text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	}
	return {
		path,
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		maxBytes: MAX_INSTRUCTION_BYTES,
	};
}

/**
 * 写回个性化指令。
 *
 * 超过预算时直接拒绝：界面若显示保存成功、模型却只读到截断内容，使用者会以为指令已经
 * 完整生效。先写临时文件再改名，避免写到一半失败毁掉原有内容。
 */
export function writePersonalization(text: string): void {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_INSTRUCTION_BYTES) {
		throw new Error(`个性化指令不能超过 ${MAX_INSTRUCTION_BYTES / 1024} KB`);
	}
	const path = personalizationPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, text, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * 读取规则正文。
 *
 * 文件缺失、读不出来或内容为空都跳过：规则是可选的上下文，单个坏文件不该让整轮对话起不来。
 * 总预算用完后截断，并在最后一段标明，模型才不会把不完整的内容当成全部。
 */
export function readInstructions(
	sources: readonly InstructionSource[],
): readonly PromptInstruction[] {
	const entries: PromptInstruction[] = [];
	let remaining = MAX_INSTRUCTION_BYTES;
	let truncated = false;

	for (let index = 0; index < sources.length; index += 1) {
		const source = sources[index];
		if (source === undefined) continue;

		if (remaining <= 0) {
			// 预算用完时，只有后面确实还有文件才标记截断
			if (sources.slice(index).some((item) => isFile(item.path))) truncated = true;
			break;
		}

		const file = readCapped(source.path, remaining);
		if (file === undefined) continue;
		remaining = Math.max(0, remaining - file.bytes);
		if (file.truncated) truncated = true;

		const text = file.text.trim();
		if (text.length === 0) continue;
		entries.push({ label: source.label, text });
	}

	if (truncated && entries.length > 0) {
		const last = entries[entries.length - 1];
		if (last !== undefined) {
			entries[entries.length - 1] = {
				...last,
				text: `${last.text}\n\n… (instructions truncated at ${MAX_INSTRUCTION_BYTES / 1024} KB)`,
			};
		}
	}
	return entries;
}

/** 最多读取 limit 字节；大文件只取前缀，并在末尾去掉被切断的 UTF-8 残片。 */
function readCapped(
	path: string,
	limit: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } | undefined {
	let size: number;
	try {
		const info = statSync(path);
		if (!info.isFile()) return undefined;
		size = info.size;
	} catch {
		return undefined;
	}

	const length = Math.min(size, limit);
	const buffer = Buffer.alloc(length);
	let descriptor: number | undefined;
	let read = 0;
	try {
		descriptor = openSync(path, "r");
		read = readSync(descriptor, buffer, 0, length, 0);
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}

	const decoded = new TextDecoder("utf-8").decode(buffer.subarray(0, read));
	return {
		// 行尾统一成 LF：提示词与提示词分段哈希都不该因为平台换行符而不同
		text: decoded.replace(/\uFFFD+$/, "").replace(/\r\n?/g, "\n").trimEnd(),
		bytes: read,
		truncated: size > limit,
	};
}
