import { readdirSync, statSync } from "node:fs";
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
				const stats = statSync(absolute);
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
