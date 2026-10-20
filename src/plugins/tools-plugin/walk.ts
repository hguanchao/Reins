import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * 目录遍历。
 *
 * 跳过版本控制与依赖目录：这两个地方的文件数量和相关性都远低于它们的体量，把它们纳入结果
 * 只会淹没真正的内容。软链接一律不跟随，否则一个指回上层的链接就能让遍历无限展开。
 */

export interface WalkEntry {
	readonly absolute: string;
	readonly relative: string;
	readonly kind: "file" | "directory";
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/**
 * 单次遍历最多读取的条目数。
 *
 * 遍历本身是同步的，超大目录树会把界面卡住；这里给一个硬上限，作为工具层之外的兜底。
 */
export const MAX_WALK_ENTRIES = 100_000;

export interface WalkOptions {
	/** 最多产出多少条，达到上限即停止 */
	readonly maxEntries: number;
}

/**
 * 逐个产出目录里的条目，深度优先。
 *
 * 用生成器而不是先收集再返回：上层常常只想要前若干条，收集全部会白读整个目录树。
 */
export function* walk(root: string, options: WalkOptions): Generator<WalkEntry> {
	const queue: string[] = [root];
	let produced = 0;

	while (queue.length > 0) {
		const directory = queue.shift() as string;
		let names: readonly string[];
		try {
			names = readdirSync(directory).sort();
		} catch {
			// 读不了的目录直接跳过：权限或竞态造成的问题不该中断整次遍历
			continue;
		}

		for (const name of names) {
			if (produced >= options.maxEntries) return;
			if (SKIPPED_DIRECTORIES.has(name)) continue;

			const absolute = join(directory, name);
			let kind: WalkEntry["kind"];
			try {
				// 必须用 lstat：stat 会跟着链接走过去，isSymbolicLink 就永远为假
				const stats = lstatSync(absolute);
				if (stats.isSymbolicLink()) continue;
				if (stats.isDirectory()) kind = "directory";
				else if (stats.isFile()) kind = "file";
				else continue;
			} catch {
				continue;
			}

			produced += 1;
			yield { absolute, relative: toPosix(relative(root, absolute)), kind };
			if (kind === "directory") queue.push(absolute);
		}
	}
}

/** 统一用正斜杠：结果要交给模型与配置，跨平台显示成一致的写法更省事。 */
export function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/**
 * 用 git 列出目录里的文件。
 *
 * `ls-files -- .` 的输出相对当前目录，正好与遍历起点一致；`--others --exclude-standard`
 * 让未跟踪但未被忽略的文件也进入结果。不是仓库或 git 不可用时返回 undefined，由调用方回退。
 */
export function listGitFiles(root: string): readonly string[] | undefined {
	const result = spawnSync(
		"git",
		["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
		{ timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.status !== 0 || result.stdout === null) return undefined;
	return result.stdout
		.toString("utf8")
		.split("\0")
		.filter((path) => path.length > 0)
		.map(toPosix);
}

/**
 * 产出目录里的文件。
 *
 * git 仓库优先用 git 的清单：它已经处理了 .gitignore，也不会进入构建产物目录；其余情况
 * 回退到自己的遍历。两条路径都跳过符号链接，保证工具不会跟着链接跑出搜索范围。
 */
export function* fileEntries(root: string, maxEntries: number): Generator<WalkEntry> {
	const gitFiles = listGitFiles(root);
	if (gitFiles !== undefined) {
		let produced = 0;
		for (const relativePath of gitFiles) {
			if (produced >= maxEntries) return;
			const entry = fileEntry(root, relativePath);
			if (entry === undefined) continue;
			produced += 1;
			yield entry;
		}
		return;
	}

	for (const entry of walk(root, { maxEntries })) {
		if (entry.kind === "file") yield entry;
	}
}

function fileEntry(root: string, relativePath: string): WalkEntry | undefined {
	const absolute = join(root, relativePath);
	try {
		const stats = lstatSync(absolute);
		if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
		return { absolute, relative: toPosix(relativePath), kind: "file" };
	} catch {
		return undefined;
	}
}

/**
 * 把通配模式编译成正则。
 *
 * `**` 跨目录，`*` 不跨目录，`?` 匹配单个字符。只支持这三个是刻意的：更复杂的模式（字符组、
 * 花括号展开）用的人少，而实现它们的边界情形不少，写错的匹配比少支持的匹配难排查得多。
 */
export function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
				// 吃掉 ** 后面紧跟的分隔符，这样 `**/*.ts` 也能匹配到根目录下的文件
				if (pattern[index + 1] === "/") index += 1;
				continue;
			}
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += char.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}
