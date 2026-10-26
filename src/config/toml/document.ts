import { offsetToLineColumn, type LineColumn } from "../error.ts";
import { aliasOf } from "../keys.ts";
import type { ConfigSource } from "../reader.ts";
import {
	isConfigTable,
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
	 */
	set(path: readonly string[], value: ConfigValue): void {
		if (path.length === 0) throw new Error("Key path for write must not be empty");
		this.#load(this.#render(path, value));
	}

	#render(path: readonly string[], value: ConfigValue): string {
		const newline = this.#lineEnding();
		// 读路径同时认 snake_case 与 camelCase。写路径若只按精确路径找，使用者在配置里写了
		// camelCase 时就会在文件末尾再补一条 snake_case，下次读出来两边冲突、整份配置失效。
		const assignment = this.#assignments.find((item) => samePath(item.path, path) || samePath(item.path, this.#aliasPath(path)));
		if (assignment !== undefined) {
			return (
				this.#source.slice(0, assignment.valueStart) +
				serializeValue(value) +
				this.#source.slice(assignment.valueEnd)
			);
		}

		const line = `${serializeKey(path[path.length - 1])} = ${serializeValue(value)}${newline}`;
		const tablePath = path.slice(0, -1);
		const section = this.#sections.find(
			(item) => samePath(item.path, tablePath) || samePath(item.path, this.#aliasPath(tablePath)),
		);
		if (section !== undefined) {
			return this.#insertAfter(section.bodyEnd, line, newline);
		}

		// 父表可能以点号键（`plugins.disabled = []`）或内联表（`plugins = { ... }`）存在：
		// 那种情况下没有对应的 [section]，再补一个表头会被解析器判为重复定义。
		if (this.#hasImplicitTable(tablePath)) {
			return this.#insertAfter(this.#implicitTableEnd(tablePath), line, newline);
		}

		const header = `[${tablePath.map(serializeKey).join(".")}]`;
		return `${this.#withTrailingBlankLine()}${header}${newline}${line}`;
	}

	/** 在某个偏移处插入一整行，并保证插入点前有换行。 */
	#insertAfter(offset: number, line: string, newline: string): string {
		const before = this.#source.slice(0, offset);
		// 文件末尾没有换行时直接拼上去会把两行粘成一行，重新解析就报错
		const separator = before.length === 0 || before.endsWith(newline) ? "" : newline;
		return `${before}${separator}${line}${this.#source.slice(offset)}`;
	}

	/** 路径上的键是否以点号键或内联表的形式存在（因而没有自己的 [section] 表头）。 */
	#hasImplicitTable(path: readonly string[]): boolean {
		if (path.length === 0) return false;
		const assignment = this.#assignments.find((item) => samePath(item.path, path));
		if (assignment === undefined) return false;
		// 点号键与内联表在解析结果里都是一条赋值
		return true;
	}

	/** 隐式表的结尾：紧跟在它那条赋值之后。 */
	#implicitTableEnd(path: readonly string[]): number {
		const assignment = this.#assignments.find((item) => samePath(item.path, path));
		return assignment?.valueEnd ?? this.#source.length;
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
