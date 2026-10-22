import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	agentsSkillsDir,
	projectAgentsSkillsDir,
	projectSkillsDir,
	skillsDir,
} from "../config/paths.ts";

/**
 * 技能发现。
 *
 * 一个技能是 `<根目录>/<目录>/SKILL.md`：文件开头用 frontmatter 声明 name 与 description，
 * 省略 name 时取目录名。每个根只扫一层，不递归——技能名取自目录名，递归下去就得另发明一套
 * 命名规则，反而没人说得清哪个名字才算数。
 *
 * 同名技能按「项目级覆盖用户级」取舍：跟着这个仓库走的那一份更贴近当下的工作。
 */

/** SKILL.md 里能被识别出来的两项；其余字段留给以后，现在读了也没处用。 */
interface Frontmatter {
	name: string | undefined;
	description: string | undefined;
}

export type SkillScope = "user" | "project";

export interface SkillRoot {
	readonly directory: string;
	readonly scope: SkillScope;
}

export interface SkillInfo {
	readonly name: string;
	/** 一行说明，可能为空 */
	readonly description: string;
	/** SKILL.md 的绝对路径：模型靠它去读正文 */
	readonly path: string;
	readonly scope: SkillScope;
	/** 技能目录，用来区分同名技能 */
	readonly directory: string;
}

const SKILL_FILE = "SKILL.md";
const FRONTMATTER_FENCE = "---";
/** 只读文件开头这么多字节：frontmatter 在这里，正文再长也不必整份读进来 */
const HEAD_BYTES = 8 * 1024;

/**
 * 默认技能根。
 *
 * 用户级两根总是扫：Reins 自己的约定，加上 `.agents/skills` 这个跨工具位置。项目级同样两根，
 * 但它会进系统提示词，因此和项目配置一样必须先取得工作区信任——否则 clone 一个仓库就能往
 * 提示词里塞东西。
 */
export function defaultSkillRoots(workRoot: string, trusted: boolean): readonly SkillRoot[] {
	const roots: SkillRoot[] = [
		{ directory: skillsDir(), scope: "user" },
		{ directory: agentsSkillsDir(), scope: "user" },
	];
	if (trusted) {
		roots.push(
			{ directory: projectSkillsDir(workRoot), scope: "project" },
			{ directory: projectAgentsSkillsDir(workRoot), scope: "project" },
		);
	}
	return roots;
}

/**
 * 扫描全部根目录。
 *
 * 目录不存在就当作没有技能：大多数人不会写技能，为此报错只会让人以为哪里配错了。单个文件
 * 读不出来也跳过，一个坏文件不该让整张清单消失。
 */
export function discoverSkills(roots: readonly SkillRoot[]): readonly SkillInfo[] {
	const byName = new Map<string, SkillInfo>();
	for (const root of roots) {
		for (const skill of discoverRoot(root)) {
			const existing = byName.get(skill.name);
			// 项目级优先：已经收下的项目级技能不被用户级的同名项顶掉
			if (existing !== undefined && existing.scope === "project") continue;
			byName.set(skill.name, skill);
		}
	}

	// 按名字排，不按目录名：改了 name 之后清单顺序才跟显示的一致
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function discoverRoot(root: SkillRoot): readonly SkillInfo[] {
	let entries: readonly string[];
	try {
		entries = readdirSync(root.directory);
	} catch {
		return [];
	}

	const skills: SkillInfo[] = [];
	for (const entry of entries) {
		const path = join(root.directory, entry, SKILL_FILE);
		const contents = readSkillFile(path);
		if (contents === undefined) continue;

		const front = parseFrontmatter(contents);
		skills.push({
			name: front.name ?? entry,
			description: front.description ?? "",
			path,
			scope: root.scope,
			directory: join(root.directory, entry),
		});
	}
	return skills;
}

function readSkillFile(path: string): string | undefined {
	// frontmatter 一定在开头；清单每轮都要扫一遍，只读开头这一段，别让某个大文件拖慢一轮
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = readSync(descriptor, buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		// 目录不是技能目录，或者文件读不出来：两种情况都当作「这里没有技能」
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * 解析开头的 frontmatter。
 *
 * 只认单行的 `key: value`，不引入 YAML 解析器：这两项都是短标量，为一份清单背上整套 YAML
 * 语义不划算。没有 frontmatter、没有收尾的 `---` 都按空处理，名称回退到目录名。
 */
function parseFrontmatter(contents: string): Frontmatter {
	const lines = contents.split(/\r?\n/);
	if (lines[0]?.trim() !== FRONTMATTER_FENCE) return { name: undefined, description: undefined };

	const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
	if (end < 0) return { name: undefined, description: undefined };

	const front: Frontmatter = { name: undefined, description: undefined };
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = unquote(line.slice(separator + 1).trim());
		if (value.length === 0) continue;
		if (key === "name") front.name = value;
		if (key === "description") front.description = value;
	}
	return front;
}

/** 去掉成对的引号；只去一对，不处理转义——写技能的人不会在这里放嵌套引号。 */
function unquote(value: string): string {
	const first = value[0];
	if (value.length < 2) return value;
	if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
	return value;
}
