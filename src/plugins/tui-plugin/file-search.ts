import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * `@` 文件引用。
 *
 * 光标停在一个 `@` 词里时，用工作区文件清单做模糊匹配。清单在会话启动后异步建立，不阻塞
 * 输入；版本控制目录与依赖目录始终跳过，其余以点开头的路径只在 `@!` 模式下才出现。
 */

export interface AtContext {
	/** 整个 `@` 标记在文本里的范围，包含 `@`，不含后面的空白。 */
	readonly start: number;
	readonly end: number;
	/** `@` 之后、光标之前的原始查询词，可能带 `!` 前缀。 */
	readonly query: string;
	readonly hidden: boolean;
}

export interface FileEntry {
	/** 相对工作根的路径，统一用正斜杠。 */
	readonly path: string;
	readonly kind: "file" | "directory";
}

export interface IndexOptions {
	readonly maxEntries?: number;
}

const SKIPPED = new Set([".git", "node_modules"]);
const MAX_QUERY_RESULTS = 200;

/**
 * 判断光标是否位于一个 `@` 词里。
 *
 * `@` 前面紧挨着字母、数字或下划线时不触发，避免把邮箱地址当成文件引用。词在空白、逗号或
 * 分号处结束；光标越过词尾就不再补全。
 */
export function detectAtContext(text: string, cursor: number): AtContext | undefined {
	const position = Math.max(0, Math.min(cursor, text.length));
	const at = text.lastIndexOf("@", position - 1);
	if (at < 0) return undefined;

	const previous = at > 0 ? text[at - 1] : undefined;
	if (previous !== undefined && (isWordCharacter(previous) || previous === "_")) return undefined;

	const end = tokenEnd(text, at);
	if (position > end) return undefined;

	const query = text.slice(at + 1, position);
	return { start: at, end, query, hidden: query.startsWith("!") };
}

/** 按查询词过滤并排序；空查询先列目录，再按路径深度与字母序。 */
export function matchFiles(
	files: readonly FileEntry[],
	query: string,
): readonly FileEntry[] {
	const hidden = query.startsWith("!");
	const needle = (hidden ? query.slice(1) : query).toLowerCase();
	const scoped = needle.endsWith("/") ? needle : undefined;

	const ranked: { entry: FileEntry; rank: number }[] = [];
	for (const entry of files) {
		if (!hidden && isHiddenPath(entry.path)) continue;
		if (scoped !== undefined) {
			if (!entry.path.startsWith(scoped) || entry.path === scoped) continue;
			ranked.push({ entry, rank: 0 });
			continue;
		}

		const rank = matchRank(entry, needle);
		if (rank !== undefined) ranked.push({ entry, rank });
	}

	ranked.sort((left, right) => {
		if (left.rank !== right.rank) return left.rank - right.rank;
		if (left.entry.kind !== right.entry.kind) return left.entry.kind === "directory" ? -1 : 1;
		const depth = pathDepth(left.entry.path) - pathDepth(right.entry.path);
		if (depth !== 0) return depth;
		if (left.entry.path.length !== right.entry.path.length) {
			return left.entry.path.length - right.entry.path.length;
		}
		return left.entry.path.localeCompare(right.entry.path);
	});

	return ranked.slice(0, MAX_QUERY_RESULTS).map((item) => item.entry);
}

/**
 * 建立工作区文件清单。
 *
 * 广度优先，达到上限就停；单个目录读不了只跳过它，不让一次权限错误中断整次扫描。软链接不
 * 跟随，避免链接指回上层造成循环。
 */
export async function indexWorkspaceFiles(
	root: string,
	options: IndexOptions = {},
): Promise<readonly FileEntry[]> {
	const maxEntries = options.maxEntries ?? 20_000;
	const entries: FileEntry[] = [];
	const queue: string[] = [""];

	while (queue.length > 0 && entries.length < maxEntries) {
		const directory = queue.shift() as string;
		let dirents;
		try {
			dirents = await readdir(join(root, directory), { withFileTypes: true });
		} catch {
			continue;
		}
		dirents.sort((left, right) => left.name.localeCompare(right.name));

		for (const dirent of dirents) {
			if (entries.length >= maxEntries) break;
			if (SKIPPED.has(dirent.name) || dirent.isSymbolicLink()) continue;

			const path = toPosix(join(directory, dirent.name));
			if (dirent.isDirectory()) {
				entries.push({ path, kind: "directory" });
				queue.push(path);
			} else if (dirent.isFile()) {
				entries.push({ path, kind: "file" });
			}
		}
	}

	return entries;
}

/** 查询为空时全部入选，否则按精确、前缀、子序列分档。 */
function matchRank(entry: FileEntry, needle: string): number | undefined {
	if (needle.length === 0) return 0;
	const path = entry.path.toLowerCase();
	const slash = path.lastIndexOf("/");
	const base = slash < 0 ? path : path.slice(slash + 1);

	if (base === needle) return 0;
	if (base.startsWith(needle)) return 1;
	if (path.startsWith(needle)) return 2;
	if (isSubsequence(base, needle)) return 3;
	if (isSubsequence(path, needle)) return 4;
	return undefined;
}

function isSubsequence(haystack: string, needle: string): boolean {
	let index = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, index);
		if (found < 0) return false;
		index = found + 1;
	}
	return true;
}

function tokenEnd(text: string, at: number): number {
	for (let index = at + 1; index < text.length; index += 1) {
		const char = text[index];
		if (/\s/.test(char) || char === "," || char === ";") return index;
	}
	return text.length;
}

function isHiddenPath(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("."));
}

function pathDepth(path: string): number {
	return path.split("/").length;
}

function isWordCharacter(char: string): boolean {
	return /[\p{L}\p{N}]/u.test(char);
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}
