import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

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
	/** 连 .gitignore 里的文件也收进来；`@!` 模式用它 */
	readonly includeIgnored?: boolean;
}

const SKIPPED = new Set([".git", "node_modules"]);
const MAX_QUERY_RESULTS = 200;
const execFileAsync = promisify(execFile);

/**
 * 判断光标是否位于一个 `@` 词里。
 *
 * `@` 前面紧挨着字母、数字或下划线时不触发，避免把邮箱地址当成文件引用。词在空白、逗号或
 * 分号处结束；光标越过词尾就不再补全。
 *
 * `drillPrefix` 是刚钻进去的目录路径。路径本身可能含空格，因此前缀内部的空白不当作词尾，
 * 前缀之后的空白仍然结束这个 `@` 词。
 */
export function detectAtContext(
	text: string,
	cursor: number,
	drillPrefix?: string,
): AtContext | undefined {
	const position = Math.max(0, Math.min(cursor, text.length));
	const at = text.lastIndexOf("@", position - 1);
	if (at < 0) return undefined;

	const previous = at > 0 ? text[at - 1] : undefined;
	if (previous !== undefined && (isWordCharacter(previous) || previous === "_")) return undefined;

	const contentStart = at + 1;
	const afterBang = text[contentStart] === "!" ? contentStart + 1 : contentStart;
	const internalUntil =
		drillPrefix !== undefined && drillPrefix.length > 0 && text.slice(afterBang).startsWith(drillPrefix)
			? afterBang + drillPrefix.length
			: undefined;

	const end = tokenEnd(text, at, internalUntil);
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
			const path = entry.path.toLowerCase();
			if (!path.startsWith(scoped) || path === scoped) continue;
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
	// `@!` 要看到被忽略的文件，git 清单天然看不到它们，直接走目录遍历
	if (options.includeIgnored !== true) {
		const fromGit = await indexWithGit(root, maxEntries);
		if (fromGit !== undefined) return fromGit;
	}
	return indexByWalk(root, maxEntries);
}

/**
 * 用 `git ls-files` 取工作区文件：它天然遵守 `.gitignore`，路径以 NUL 分隔，带空格也安全。
 * 不是 git 仓库或没有 git 时返回 undefined，交给目录遍历兜底。
 */
async function indexWithGit(root: string, maxEntries: number): Promise<readonly FileEntry[] | undefined> {
	let stdout: string;
	try {
		const result = await execFileAsync(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
			{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		stdout = result.stdout;
	} catch {
		return undefined;
	}

	const entries: FileEntry[] = [];
	const seen = new Set<string>();
	for (const raw of stdout.split("\0")) {
		if (raw.length === 0) continue;
		const path = raw.replaceAll("\\", "/");
		const parts = path.split("/");
		for (let index = 1; index < parts.length && entries.length < maxEntries; index += 1) {
			const directory = parts.slice(0, index).join("/");
			if (seen.has(directory)) continue;
			seen.add(directory);
			entries.push({ path: directory, kind: "directory" });
		}
		if (entries.length >= maxEntries) break;
		if (seen.has(path)) continue;
		seen.add(path);
		entries.push({ path, kind: "file" });
	}
	return entries;
}

async function indexByWalk(root: string, maxEntries: number): Promise<readonly FileEntry[]> {
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

function tokenEnd(text: string, at: number, internalUntil: number | undefined): number {
	for (let index = at + 1; index < text.length; index += 1) {
		const char = text[index];
		if (!/\s/.test(char) && char !== "," && char !== ";") continue;
		if (internalUntil !== undefined && index < internalUntil) continue;
		return index;
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
