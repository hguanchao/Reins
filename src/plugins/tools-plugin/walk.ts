import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import ignore from "ignore";

/**
 * 目录遍历。
 *
 * 过滤口径就是 .gitignore：每进入一层就读该层的 .gitignore，祖先目录里的规则同样生效（向上找到
 * 仓库根为止）。子目录的规则覆盖父目录的，`!` 取反同样以最近的一条为准——与 git 的优先级一致。
 * .git 目录本身始终不进入：那是版本库自己的数据，不是项目内容。软链接一律不跟随，否则一个
 * 指回上层的链接就能让遍历无限展开。
 *
 * 条目类型一律取自 readdir 的 dirent：每条再 stat 一次会让遍历慢一个数量级。
 */

export interface WalkEntry {
	readonly absolute: string;
	readonly relative: string;
	readonly kind: "file" | "directory";
}

/** 版本库目录：git 自己也不把它当作内容。 */
const VCS_DIRECTORY = ".git";
const IGNORE_FILE = ".gitignore";

/** 遍历起点内部的规则层；base 是它所在目录相对起点的路径，空串表示起点本身。 */
interface IgnoreLayer {
	readonly base: string;
	readonly matcher: ReturnType<typeof ignore>;
}

/** 祖先目录的规则层；prefix 是起点相对该祖先的路径，空串表示起点就是祖先本身。 */
interface AncestorLayer {
	readonly prefix: string;
	readonly matcher: ReturnType<typeof ignore>;
}

/** 待遍历的一层目录，连同它继承下来的忽略规则。 */
interface Pending {
	readonly absolute: string;
	readonly relative: string;
	readonly layers: readonly IgnoreLayer[];
}

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
	const ancestors = ancestorLayers(root);
	const queue: Pending[] = [{ absolute: root, relative: "", layers: [] }];
	let produced = 0;

	while (queue.length > 0) {
		const directory = queue.shift() as Pending;
		let dirents: Dirent[];
		try {
			dirents = readdirSync(directory.absolute, { withFileTypes: true });
		} catch {
			// 读不了的目录直接跳过：权限或竞态造成的问题不该中断整次遍历
			continue;
		}
		dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

		// 先拿到这一层的规则再遍历子项：判定要用上它，且 dirent 已经告诉我们有没有 .gitignore
		const own = ignoreLayerOf(directory.absolute, directory.relative, dirents);
		const layers = own === undefined ? directory.layers : [...directory.layers, own];

		for (const dirent of dirents) {
			if (produced >= options.maxEntries) return;
			const name = dirent.name;
			if (name === VCS_DIRECTORY) continue;

			const absolute = join(directory.absolute, name);
			const kind = kindOf(dirent, absolute);
			if (kind === undefined) continue;

			const relativePath = directory.relative.length === 0 ? name : `${directory.relative}/${name}`;
			// 目录带尾斜杠再判定：`build/` 这类只匹配目录的规则才生效
			const scoped = kind === "directory" ? `${relativePath}/` : relativePath;
			if (isIgnored(ancestors, layers, scoped)) continue;

			produced += 1;
			yield { absolute, relative: relativePath, kind };
			if (kind === "directory") queue.push({ absolute, relative: relativePath, layers });
		}
	}
}

/**
 * 条目类型。
 *
 * 直接取 dirent 里带的类型，不再对每条 lstat 一次——那是整次遍历最贵的一步。少数文件系统
 * （部分网络盘与 FUSE）不返回类型，这时才退回一次 lstat。
 */
function kindOf(dirent: Dirent, absolute: string): WalkEntry["kind"] | undefined {
	if (dirent.isSymbolicLink()) return undefined;
	if (dirent.isDirectory()) return "directory";
	if (dirent.isFile()) return "file";
	try {
		const stats = lstatSync(absolute);
		if (stats.isSymbolicLink()) return undefined;
		if (stats.isDirectory()) return "directory";
		return stats.isFile() ? "file" : undefined;
	} catch {
		return undefined;
	}
}

/** 这一层目录自己的 .gitignore；没有、读不了或是空的都算没有规则。 */
function ignoreLayerOf(
	absolute: string,
	base: string,
	dirents: readonly Dirent[],
): IgnoreLayer | undefined {
	const present = dirents.some((dirent) => dirent.name === IGNORE_FILE && dirent.isFile());
	if (!present) return undefined;
	const source = readIfPresent(join(absolute, IGNORE_FILE));
	// 空文件不建规则层：否则每个条目都要白跑一次匹配
	if (source === undefined || source.trim().length === 0) return undefined;
	return { base, matcher: ignore().add(source) };
}

/**
 * 祖先目录的规则。
 *
 * 与 git 一致：从遍历起点的父目录开始向上读 .gitignore，遇到仓库根（含 .git 的目录）就停，
 * 再往上不属于这个项目。越近的祖先越优先。
 *
 * 起点自己被祖先规则忽略时整条祖先链都不作数：使用者明确点名了这个目录，就按他说的列——
 * 否则 `ls reference/` 这种「点名一个被忽略的目录」会得到空结果。
 */
function ancestorLayers(root: string): readonly AncestorLayer[] {
	const layers: AncestorLayer[] = [];
	let directory = dirname(root);
	let prefix = basename(root);

	for (;;) {
		const source = readIfPresent(join(directory, IGNORE_FILE));
		if (source !== undefined && source.trim().length > 0) {
			layers.push({ prefix, matcher: ignore().add(source) });
		}
		if (existsSync(join(directory, VCS_DIRECTORY))) break;
		const parent = dirname(directory);
		if (parent === directory) break;
		prefix = `${basename(directory)}/${prefix}`;
		directory = parent;
	}

	for (const layer of layers) {
		const verdict = verdictOf(layer.matcher, `${layer.prefix}/`);
		if (verdict !== undefined) return verdict ? [] : layers;
	}
	return layers;
}

function readIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * 判定一条路径是否被忽略。
 *
 * 顺序就是优先级：起点内的规则由深到浅，然后是祖先由近到远。先给出结论的一层说了算，
 * 因此子目录的 `!` 可以推翻父目录的忽略，与 git 一致。
 */
function isIgnored(
	ancestors: readonly AncestorLayer[],
	layers: readonly IgnoreLayer[],
	path: string,
): boolean {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer === undefined) continue;
		if (layer.base.length > 0 && !path.startsWith(`${layer.base}/`)) continue;
		const scoped = layer.base.length === 0 ? path : path.slice(layer.base.length + 1);
		const verdict = verdictOf(layer.matcher, scoped);
		if (verdict !== undefined) return verdict;
	}
	for (const layer of ancestors) {
		const scoped = layer.prefix.length === 0 ? path : `${layer.prefix}/${path}`;
		const verdict = verdictOf(layer.matcher, scoped);
		if (verdict !== undefined) return verdict;
	}
	return false;
}

/** true 表示忽略，false 表示明确保留，undefined 表示这一层没有意见。 */
function verdictOf(matcher: ReturnType<typeof ignore>, path: string): boolean | undefined {
	const result = matcher.test(path);
	if (result.ignored) return true;
	if (result.unignored) return false;
	return undefined;
}

/** 统一用正斜杠：结果要交给模型与配置，跨平台显示成一致的写法更省事。 */
function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/**
 * 用 git 列出目录里的文件。
 *
 * `ls-files -- .` 的输出相对当前目录，正好与遍历起点一致；`--others --exclude-standard`
 * 让未跟踪但未被忽略的文件也进入结果。不是仓库或 git 不可用时返回 undefined，由调用方回退。
 */
function listGitFiles(root: string): readonly string[] | undefined {
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
