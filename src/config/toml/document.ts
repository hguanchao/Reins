import { offsetToLineColumn, type LineColumn } from "../error.ts";
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
		const assignment = this.#assignments.find((item) => samePath(item.path, path));
		if (assignment !== undefined) {
			return (
				this.#source.slice(0, assignment.valueStart) +
				serializeValue(value) +
				this.#source.slice(assignment.valueEnd)
			);
		}

		const line = `${serializeKey(path[path.length - 1])} = ${serializeValue(value)}${newline}`;
		const tablePath = path.slice(0, -1);
		const section = this.#sections.find((item) => samePath(item.path, tablePath));
		if (section !== undefined) {
			return this.#source.slice(0, section.bodyEnd) + line + this.#source.slice(section.bodyEnd);
		}

		const header = `[${tablePath.map(serializeKey).join(".")}]`;
		return `${this.#withTrailingBlankLine()}${header}${newline}${line}`;
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
