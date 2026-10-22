import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 技能发现。
 *
 * 一个技能是 `skills/<目录>/SKILL.md`：文件开头用 frontmatter 声明 name 与 description，
 * 省略 name 时取目录名。只扫一层，不递归——技能名取自目录名，递归下去就得另发明一套命名
 * 规则，反而没人说得清哪个名字才算数。
 *
 * 与插件发现一样，目录不存在就当作没有技能：大多数人不会写技能，为此报错只会让人以为哪里
 * 配错了。单个文件读不出来也跳过，一个坏文件不该让整张清单消失。
 */

/** SKILL.md 里能被识别出来的两项；其余字段留给以后，现在读了也没处用。 */
interface Frontmatter {
	name: string | undefined;
	description: string | undefined;
}

export interface SkillInfo {
	readonly name: string;
	/** 一行说明，可能为空 */
	readonly description: string;
	/** 技能目录，用来区分同名技能 */
	readonly directory: string;
}

const SKILL_FILE = "SKILL.md";
const FRONTMATTER_FENCE = "---";

export function discoverSkills(directory: string): readonly SkillInfo[] {
	let entries: readonly string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}

	const skills: SkillInfo[] = [];
	for (const entry of entries) {
		const path = join(directory, entry, SKILL_FILE);
		const contents = readSkillFile(path);
		if (contents === undefined) continue;

		const front = parseFrontmatter(contents);
		skills.push({
			name: front.name ?? entry,
			description: front.description ?? "",
			directory: join(directory, entry),
		});
	}

	// 按名字排，不按目录名：改了 name 之后清单顺序才跟显示的一致
	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function readSkillFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// 目录不是技能目录，或者文件读不出来：两种情况都当作「这里没有技能」
		return undefined;
	}
}

/**
 * 解析开头的 frontmatter。
 *
 * 只认单行的 `key: value`，不引入 YAML 解析器：这两项都是短标量，为一个清单命令背上整
 * 套 YAML 语义不划算。没有 frontmatter、没有收尾的 `---` 都按空处理，名称回退到目录名。
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
