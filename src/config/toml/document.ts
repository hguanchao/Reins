import { ConfigError, offsetToLineColumn, type LineColumn } from "../error.ts";
import { aliasOf } from "../keys.ts";
import type { ConfigSource } from "../reader.ts";
import {
	isConfigTable,
	setTableValue,
	tableValue,
	type ConfigPath,
	type ConfigTable,
	type ConfigValue,
} from "../value.ts";
import { TomlParser, type TomlAssignment, type TomlSection } from "./parser.ts";
import { serializeKey, serializeValue } from "./serialize.ts";

function samePath(left: readonly string[] | null, right: ConfigPath): boolean {
	if (left === null) return right.length === 0;
	if (left.length !== right.length) return false;
	return left.every((part, index) => part === right[index]);
}

/** 写入前后的深比较：回写是否真的落在目标路径上，只靠它判定。 */
function sameValue(left: ConfigValue | undefined, right: ConfigValue): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
	}
	if (left !== undefined && isConfigTable(left) && isConfigTable(right)) {
		const keys = Object.keys(left);
		return (
			keys.length === Object.keys(right).length &&
			keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
		);
	}
	return false;
}

/**
 * 父表在原文里的存在形式。
 *
 * 内联表与点号键都没有自己的 [section] 表头，补一个会被解析器判成重复定义，所以只能按
 * 原形式写入。actual 是原文里实际用的那种写法：混用两种写法会得到两个不同的表。
 */
type ParentForm =
	| { readonly kind: "inline"; readonly assignment: TomlAssignment; readonly actual: readonly string[] }
	| { readonly kind: "dotted"; readonly end: number; readonly actual: readonly string[] };

/** 一次回写的结果：新文本，以及值实际落在哪个路径上。 */
interface RenderedWrite {
	readonly source: string;
	readonly path: readonly string[];
}

/**
 * 保留原文的 TOML 文档：既能读出值，也能定点回写单个键。
 *
 * 回写之所以要保原文，是因为配置里有几处由程序自动写入的内容（信任的工作区根、
 * 通知方式），改写它们时不能把使用者手写的注释与排版冲掉。每次回写后重新解析，
 * 这样区间索引不会因为前一次编辑而错位——配置文件很小，重解析的代价可以忽略，
 * 换来的是不必维护一套增量更新区间坐标的逻辑。
 */
export class TomlDocument implements ConfigSource {
	#source = "";
	#root: ConfigTable = {};
	#assignments: readonly TomlAssignment[] = [];
	#sections: readonly TomlSection[] = [];

	constructor(source: string) {
		this.#load(source);
	}

	get source(): string {
		return this.#source;
	}

	get root(): ConfigTable {
		return this.#root;
	}

	/** 按键路径取值；路径上任何一段不是表、或键不存在，都返回 undefined。 */
	get(path: ConfigPath): ConfigValue | undefined {
		let current: ConfigValue | undefined = this.#root;
		for (const part of path) {
			if (current === undefined || !isConfigTable(current)) return undefined;
			// TOML 的键都是字符串，路径里出现数字只可能来自 JSON，这里统一按字符串取
			current = tableValue(current, String(part));
		}
		return current;
	}

	/** 键在原文中的位置，用于把校验错误指到具体行列。 */
	locationOf(path: ConfigPath): LineColumn | undefined {
		const assignment = this.#assignments.find((item) => samePath(item.path, path));
		if (assignment !== undefined) return offsetToLineColumn(this.#source, assignment.pathStart);

		const section = this.#sections.find((item) => samePath(item.path, path));
		if (section !== undefined) return offsetToLineColumn(this.#source, section.headerStart);

		return undefined;
	}

	/**
	 * 写入一个键。已有该键就只替换它的值；没有就插到所属表区段的末尾；
	 * 整个表都不存在时在文件末尾补一个表头再写。
	 *
	 * 写完必须回读核对：写偏了（例如把表成员写成了根级键）在这里暴露，比等到下一次
	 * 加载时整份配置报「未知键」要好得多——那时使用者已经不知道是哪次操作改坏的。
	 */
	set(path: readonly string[], value: ConfigValue): void {
		if (path.length === 0) throw new Error("Key path for write must not be empty");
		const rendered = this.#render(path, value);
		this.#load(rendered.source);
		// 按实际落点回读：别名写法下写入路径与入参不同，用入参核对会把正确的写入判成失败
		if (!sameValue(this.get(rendered.path), value)) {
			throw new ConfigError(
				`Cannot write ${path.join(".")} without moving it out of its table; ` +
					"rewrite that table as a [section] and try again",
			);
		}
	}

	#render(path: readonly string[], value: ConfigValue): RenderedWrite {
		const newline = this.#lineEnding();
		// 读路径同时认 snake_case 与 camelCase。写路径若只按精确路径找，使用者在配置里写了
		// camelCase 时就会在文件末尾再补一条 snake_case，下次读出来两边冲突、整份配置失效。
		const assignment = this.#assignments.find((item) => samePath(item.path, path) || samePath(item.path, this.#aliasPath(path)));
		if (assignment !== undefined) {
			return {
				source:
					this.#source.slice(0, assignment.valueStart) +
					serializeValue(value) +
					this.#source.slice(assignment.valueEnd),
				path: assignment.path,
			};
		}

		const line = `${serializeKey(path[path.length - 1])} = ${serializeValue(value)}${newline}`;
		const tablePath = path.slice(0, -1);
		const section = this.#sections.find(
			(item) => samePath(item.path, tablePath) || samePath(item.path, this.#aliasPath(tablePath)),
		);
		if (section !== undefined) {
			return { source: this.#insertAfter(section.bodyEnd, line, newline), path };
		}

		// 父表以点号键（`plugins.disabled = []`）或内联表（`plugins = { ... }`）存在时都没有
		// 自己的 [section] 表头，再补一个会被解析器判为重复定义。两种写法要分别处理：内联表
		// 把键并进那个值，点号键沿用点号键继续追加——写错位置的话读的时候根本拿不到。
		const parent = this.#parentForm(tablePath);
		if (parent !== undefined) {
			const target = [...parent.actual, path[path.length - 1]];
			return {
				source:
					parent.kind === "inline"
						? this.#mergeIntoInlineTable(parent.assignment, target, value)
						: this.#appendDotted(parent.end, target, value, newline),
				path: target,
			};
		}

		const header = `[${tablePath.map(serializeKey).join(".")}]`;
		return { source: `${this.#withTrailingBlankLine()}${header}${newline}${line}`, path };
	}

	/**
	 * 父表在原文里的存在形式。
	 *
	 * 别名一并认：写 `mcp_servers.x` 时，文件里可能是 `mcpServers = { ... }`。返回 actual
	 * 是为了让追加的键沿用文件既有的写法——混用两种写法会得到两个不同的表，读的时候会
	 * 撞上「只能写其中一个」。
	 */
	#parentForm(path: readonly string[]): ParentForm | undefined {
		if (path.length === 0) return undefined;
		const candidates = [path, this.#aliasPath(path)];

		for (const candidate of candidates) {
			const assignment = this.#assignments.find((item) => samePath(item.path, candidate));
			if (assignment === undefined) continue;
			const current = this.get(candidate);
			// 只有值本身是表才算内联表：`plugins = 1` 是写错形式的配置，不该被当成表去合并
			if (current !== undefined && isConfigTable(current)) {
				return { kind: "inline", assignment, actual: assignment.path };
			}
		}

		let end: number | undefined;
		let actual: readonly string[] | undefined;
		for (const assignment of this.#assignments) {
			if (assignment.path.length <= path.length) continue;
			const prefix = assignment.path.slice(0, path.length);
			if (!candidates.some((candidate) => samePath(prefix, candidate))) continue;
			if (end === undefined || assignment.valueEnd > end) {
				end = assignment.valueEnd;
				actual = prefix;
			}
		}
		return end === undefined || actual === undefined ? undefined : { kind: "dotted", end, actual };
	}

	/** 把新键并进内联表：只替换值那一段，键的位置与上下文都不动。 */
	#mergeIntoInlineTable(
		assignment: TomlAssignment,
		path: readonly string[],
		value: ConfigValue,
	): string {
		const current = this.get(assignment.path);
		const merged: ConfigTable = current !== undefined && isConfigTable(current) ? { ...current } : {};
		setTableValue(merged, String(path[path.length - 1]), value);
		return (
			this.#source.slice(0, assignment.valueStart) +
			serializeValue(merged) +
			this.#source.slice(assignment.valueEnd)
		);
	}

	/** 在点号键形式的父表末尾追加一条同样形式的点号键。 */
	#appendDotted(
		offset: number,
		path: readonly string[],
		value: ConfigValue,
		newline: string,
	): string {
		const line = `${path.map(serializeKey).join(".")} = ${serializeValue(value)}${newline}`;
		// 插在那一行的换行之后：插在值末尾会让结果多出一个空行
		return this.#insertAfter(this.#lineEndAt(offset), line, newline);
	}

	/** 从偏移处跨过紧随的行尾，落到下一行的行首；没有行尾时原样返回。 */
	#lineEndAt(offset: number): number {
		const match = /^[ \t]*(\r\n|\n)/.exec(this.#source.slice(offset));
		return match === null ? offset : offset + match[0].length;
	}

	/** 在某个偏移处插入一整行，并保证插入点前有换行。 */
	#insertAfter(offset: number, line: string, newline: string): string {
		const before = this.#source.slice(0, offset);
		// 文件末尾没有换行时直接拼上去会把两行粘成一行，重新解析就报错
		const separator = before.length === 0 || before.endsWith(newline) ? "" : newline;
		return `${before}${separator}${line}${this.#source.slice(offset)}`;
	}

	/** 主名称与别名互为替代写法；没有别名时返回原路径。 */
	#aliasPath(path: readonly string[]): readonly string[] {
		const key = path[path.length - 1];
		const alias = key === undefined ? undefined : aliasOf(key);
		return alias === undefined ? path : [...path.slice(0, -1), alias];
	}

	/**
	 * 插入新行时沿用文件既有的行尾。
	 *
	 * 配置文件在 Windows 上多半是 CRLF，固定写 LF 会让同一个文件混用两种行尾，
	 * 之后的 diff 会满屏都是空白变更。
	 */
	#lineEnding(): string {
		return this.#source.includes("\r\n") ? "\r\n" : "\n";
	}

	/** 追加新表之前留一个空行，避免与文件末尾的既有内容粘在一起。 */
	#withTrailingBlankLine(): string {
		const newline = this.#lineEnding();
		if (this.#source.length === 0) return "";
		if (this.#source.endsWith(`${newline}${newline}`)) return this.#source;
		if (this.#source.endsWith(newline)) return `${this.#source}${newline}`;
		return `${this.#source}${newline}${newline}`;
	}

	#load(source: string): void {
		const parsed = new TomlParser(source).parse();
		this.#source = source;
		this.#root = parsed.root;
		this.#assignments = parsed.assignments;
		this.#sections = parsed.sections;
	}
}
