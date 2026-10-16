import { ConfigError, offsetToLineColumn } from "../config-error.ts";
import { isConfigTable, type ConfigTable, type ConfigValue } from "../value.ts";

/** 一条赋值在原文中的位置。回写单个键时只替换 [valueStart, valueEnd) 这一段。 */
export interface TomlAssignment {
	/** 键的完整路径，点分键会展开成多段 */
	readonly path: readonly string[];
	/** 键名的起点，用于把校验错误指到这一行的行首 */
	readonly pathStart: number;
	readonly valueStart: number;
	readonly valueEnd: number;
}

/** 一个表区段：从表头（或文件开头）到本区段最后一个条目为止。 */
export interface TomlSection {
	/** 表头路径；文件开头到第一个表头之间那一段的 path 为 null */
	readonly path: readonly string[] | null;
	/** 表头行的起点；根区段为 0 */
	readonly headerStart: number;
	/** 本区段最后一个条目之后的偏移，新键插入到这里 */
	readonly bodyEnd: number;
	readonly isArrayOfTables: boolean;
}

export interface TomlParseResult {
	readonly root: ConfigTable;
	readonly assignments: readonly TomlAssignment[];
	readonly sections: readonly TomlSection[];
}

interface SectionState {
	path: string[] | null;
	headerStart: number;
	bodyEnd: number;
	isArrayOfTables: boolean;
}

interface TableHeader {
	path: string[];
	table: ConfigTable;
	isArrayOfTables: boolean;
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const DECIMAL_INTEGER = /^[+-]?(0|[1-9]\d*)$/;
const FLOAT_WITH_FRACTION = /^[+-]?(0|[1-9]\d*)\.\d+([eE][+-]?\d+)?$/;
const FLOAT_WITH_EXPONENT = /^[+-]?(0|[1-9]\d*)[eE][+-]?\d+$/;

/**
 * TOML 1.0 的解析器，不支持日期与时间。
 *
 * 结果里保留每条赋值的值区间与每个表区段的结束位置，因为配置文件需要被定点回写：
 * 改写某个键时要连同原文的注释与排版一起保留，只替换值那一段最短。解析与回写分成
 * 两个类，这里只负责把原文变成值树和区间索引。
 */
export class TomlParser {
	readonly #source: string;
	#pos = 0;

	constructor(source: string) {
		this.#source = source;
	}

	parse(): TomlParseResult {
		const root: ConfigTable = {};
		const assignments: TomlAssignment[] = [];
		const sections: TomlSection[] = [];

		let table: ConfigTable = root;
		let section: SectionState = { path: null, headerStart: 0, bodyEnd: 0, isArrayOfTables: false };

		for (;;) {
			this.#skipHorizontalWhitespace();
			if (this.#atComment()) this.#skipToLineEnd();
			if (this.#atEnd()) break;
			if (this.#atNewline()) {
				this.#consumeNewline();
				continue;
			}

			if (this.#peek() === "[") {
				sections.push(section);
				const headerStart = this.#pos;
				const header = this.#parseTableHeader(root);
				this.#finishLine("表头");
				section = {
					path: header.path,
					headerStart,
					bodyEnd: this.#pos,
					isArrayOfTables: header.isArrayOfTables,
				};
				table = header.table;
				continue;
			}

			const pathStart = this.#pos;
			const path = this.#parseKeyPath();
			this.#skipHorizontalWhitespace();
			this.#expectCharacter("=", "键之后需要等号");
			this.#skipHorizontalWhitespace();
			const valueStart = this.#pos;
			const value = this.#parseValue();
			const valueEnd = this.#pos;
			this.#assign(table, path, value);
			// 记录完整路径：解析用的是相对当前表的键，但回写要按完整路径才能定位到这一行
			assignments.push({
				path: section.path === null ? path : [...section.path, ...path],
				pathStart,
				valueStart,
				valueEnd,
			});

			this.#finishLine("赋值");
			// 只有真正写入条目的行才推进区段末尾：这样插入新键时不会插到下一段之前的
			// 空行或注释之后，注释仍与它描述的表头相邻。
			section.bodyEnd = this.#pos;
		}
		sections.push(section);

		return { root, assignments, sections };
	}

	#parseTableHeader(root: ConfigTable): TableHeader {
		const isArrayOfTables = this.#peek() === "[" && this.#peekAt(1) === "[";
		this.#pos += isArrayOfTables ? 2 : 1;
		const start = this.#pos;
		const path = this.#parseKeyPath();
		if (isArrayOfTables) {
			this.#expectText("]]", "数组表头需要以 ]] 结束");
		} else {
			this.#expectText("]", "表头需要以 ] 结束");
		}
		return { path, table: this.#defineTable(root, path, isArrayOfTables, start), isArrayOfTables };
	}

	/**
	 * 解析表头并落位。表头的路径不允许已经存在：重复定义表、或把已被值占用的路径声明成表，
	 * 都会让先写入的内容被后来者覆盖，因此一律报错而不是放任。
	 */
	#defineTable(root: ConfigTable, path: readonly string[], isArrayOfTables: boolean, start: number): ConfigTable {
		let table = root;
		for (let index = 0; index < path.length - 1; index += 1) {
			const key = path[index];
			const existing = table[key];
			if (existing === undefined) {
				const created: ConfigTable = {};
				table[key] = created;
				table = created;
				continue;
			}
			if (!isConfigTable(existing)) {
				throw this.#errorAt(`${path.slice(0, index + 1).join(".")} 已被非表的值占用`, start);
			}
			table = existing;
		}

		const last = path[path.length - 1];
		const existing = table[last];
		if (isArrayOfTables) {
			if (existing !== undefined) {
				if (!Array.isArray(existing) || existing.length === 0 || !existing.every(isConfigTable)) {
					throw this.#errorAt(`数组表 ${path.join(".")} 与已有定义冲突`, start);
				}
				const appended: ConfigTable = {};
				existing.push(appended);
				return appended;
			}
			const created: ConfigTable = {};
			table[last] = [created];
			return created;
		}

		if (existing !== undefined) {
			throw this.#errorAt(`表 ${path.join(".")} 重复定义`, start);
		}
		const created: ConfigTable = {};
		table[last] = created;
		return created;
	}

	/** 把值写进当前表；点分键会展开成嵌套的表。 */
	#assign(table: ConfigTable, path: readonly string[], value: ConfigValue): void {
		let target = table;
		for (let index = 0; index < path.length - 1; index += 1) {
			const key = path[index];
			const existing = target[key];
			if (existing === undefined) {
				const created: ConfigTable = {};
				target[key] = created;
				target = created;
				continue;
			}
			if (!isConfigTable(existing)) {
				throw this.#error(`${path.slice(0, index + 1).join(".")} 已被非表的值占用`);
			}
			target = existing;
		}

		const last = path[path.length - 1];
		if (target[last] !== undefined) {
			throw this.#error(`键 ${path.join(".")} 重复定义`);
		}
		target[last] = value;
	}

	#parseKeyPath(): string[] {
		const parts: string[] = [];
		for (;;) {
			this.#skipHorizontalWhitespace();
			parts.push(this.#parseSingleKey());
			this.#skipHorizontalWhitespace();
			if (this.#peek() !== ".") return parts;
			this.#pos += 1;
		}
	}

	#parseSingleKey(): string {
		const char = this.#peek();
		if (char === '"') return this.#parseBasicString(false);
		if (char === "'") return this.#parseLiteralString(false);

		const start = this.#pos;
		while (this.#pos < this.#source.length && BARE_KEY_CHAR.test(this.#source[this.#pos])) {
			this.#pos += 1;
		}
		if (this.#pos === start) throw this.#error("缺少键名");
		return this.#source.slice(start, this.#pos);
	}

	#parseValue(): ConfigValue {
		const char = this.#peek();
		if (char === undefined) throw this.#error("缺少值");
		if (char === '"') return this.#parseBasicString(true);
		if (char === "'") return this.#parseLiteralString(true);
		if (char === "[") return this.#parseArray();
		if (char === "{") return this.#parseInlineTable();
		return this.#parseBareValue();
	}

	#parseBareValue(): ConfigValue {
		const start = this.#pos;
		while (this.#pos < this.#source.length) {
			const char = this.#source[this.#pos];
			if (
				char === "\n" ||
				char === "\r" ||
				char === " " ||
				char === "\t" ||
				char === "," ||
				char === "]" ||
				char === "}" ||
				char === "#"
			) {
				break;
			}
			this.#pos += 1;
		}

		const raw = this.#source.slice(start, this.#pos);
		if (raw.length === 0) throw this.#errorAt("缺少值", start);
		if (raw === "true") return true;
		if (raw === "false") return false;
		if (raw.includes(":")) throw this.#errorAt("本实现不支持时间类型", start);
		if (/^\d{4}-\d{2}-\d{2}/.test(raw)) throw this.#errorAt("本实现不支持日期类型", start);
		return this.#parseNumber(raw, start);
	}

	#parseNumber(raw: string, start: number): number {
		const cleaned = raw.replaceAll("_", "");

		if (/^[+-]?(inf|nan)$/.test(cleaned)) {
			const negative = cleaned.startsWith("-");
			if (cleaned.includes("inf")) return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
			return Number.NaN;
		}
		if (/^[+-]?0x[0-9A-Fa-f]+$/.test(cleaned)) return Number.parseInt(cleaned.replace("0x", ""), 16);
		if (/^[+-]?0o[0-7]+$/.test(cleaned)) return Number.parseInt(cleaned.replace("0o", ""), 8);
		if (/^[+-]?0b[01]+$/.test(cleaned)) return Number.parseInt(cleaned.replace("0b", ""), 2);
		if (DECIMAL_INTEGER.test(cleaned)) return Number.parseInt(cleaned, 10);
		if (FLOAT_WITH_FRACTION.test(cleaned) || FLOAT_WITH_EXPONENT.test(cleaned)) {
			return Number.parseFloat(cleaned);
		}
		throw this.#errorAt(`无法识别的值 ${raw}`, start);
	}

	#parseBasicString(allowMultiline: boolean): string {
		const start = this.#pos;
		if (allowMultiline && this.#startsWith('"""')) {
			this.#pos += 3;
			return this.#readMultilineBasic(start);
		}

		this.#pos += 1;
		let out = "";
		for (;;) {
			const char = this.#peek();
			if (char === undefined) throw this.#errorAt("字符串没有闭合", start);
			if (char === "\n" || char === "\r") throw this.#errorAt("基本字符串不能跨行", start);
			if (char === '"') {
				this.#pos += 1;
				return out;
			}
			if (char === "\\") {
				out += this.#readEscape();
				continue;
			}
			out += char;
			this.#pos += 1;
		}
	}

	#readMultilineBasic(start: number): string {
		// 紧跟开定界符的换行是排版用的，不算内容
		if (this.#atNewline()) this.#consumeNewline();

		let out = "";
		for (;;) {
			if (this.#atEnd()) throw this.#errorAt("多行字符串没有闭合", start);

			if (this.#peek() === "\\") {
				let look = this.#pos + 1;
				while (look < this.#source.length && /[ \t\r]/.test(this.#source[look])) look += 1;
				if (this.#source[look] === "\n") {
					// 行尾反斜杠吃掉后面的所有空白，用于把长行折成多行
					this.#pos = look + 1;
					while (this.#pos < this.#source.length && /[ \t\r\n]/.test(this.#source[this.#pos])) this.#pos += 1;
					continue;
				}
				out += this.#readEscape();
				continue;
			}

			if (this.#startsWith('"""')) {
				let quotes = 0;
				while (this.#peekAt(quotes) === '"') quotes += 1;
				if (quotes > 5) throw this.#errorAt("多行字符串里的引号过多", start);
				out += '"'.repeat(quotes - 3);
				this.#pos += quotes;
				return out;
			}

			out += this.#source[this.#pos];
			this.#pos += 1;
		}
	}

	#parseLiteralString(allowMultiline: boolean): string {
		const start = this.#pos;
		if (allowMultiline && this.#startsWith("'''")) {
			this.#pos += 3;
			return this.#readMultilineLiteral(start);
		}

		this.#pos += 1;
		let out = "";
		for (;;) {
			const char = this.#peek();
			if (char === undefined) throw this.#errorAt("字符串没有闭合", start);
			if (char === "\n" || char === "\r") throw this.#errorAt("字面量字符串不能跨行", start);
			if (char === "'") {
				this.#pos += 1;
				return out;
			}
			out += char;
			this.#pos += 1;
		}
	}

	#readMultilineLiteral(start: number): string {
		if (this.#atNewline()) this.#consumeNewline();

		let out = "";
		for (;;) {
			if (this.#atEnd()) throw this.#errorAt("多行字符串没有闭合", start);
			if (this.#startsWith("'''")) {
				let quotes = 0;
				while (this.#peekAt(quotes) === "'") quotes += 1;
				if (quotes > 5) throw this.#errorAt("多行字符串里的引号过多", start);
				out += "'".repeat(quotes - 3);
				this.#pos += quotes;
				return out;
			}
			out += this.#source[this.#pos];
			this.#pos += 1;
		}
	}

	#readEscape(): string {
		const start = this.#pos;
		this.#pos += 1;
		const char = this.#peek();
		if (char === undefined) throw this.#errorAt("转义符后缺少内容", start);
		this.#pos += 1;

		switch (char) {
			case "b":
				return "\u0008";
			case "t":
				return "\t";
			case "n":
				return "\n";
			case "f":
				return "\f";
			case "r":
				return "\r";
			case '"':
				return '"';
			case "\\":
				return "\\";
			case "u":
				return this.#readUnicodeEscape(4, start);
			case "U":
				return this.#readUnicodeEscape(8, start);
			default:
				throw this.#errorAt(`不支持的转义 \\${char}`, start);
		}
	}

	#readUnicodeEscape(digits: number, start: number): string {
		const hex = this.#source.slice(this.#pos, this.#pos + digits);
		if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
			throw this.#errorAt(`Unicode 转义需要 ${digits} 位十六进制`, start);
		}
		this.#pos += digits;
		const code = Number.parseInt(hex, 16);
		if (code > 0x10ffff) throw this.#errorAt("Unicode 转义超出范围", start);
		return String.fromCodePoint(code);
	}

	#parseArray(): ConfigValue[] {
		const start = this.#pos;
		this.#pos += 1;
		const items: ConfigValue[] = [];

		for (;;) {
			this.#skipArrayWhitespace();
			if (this.#atEnd()) throw this.#errorAt("数组没有闭合", start);
			if (this.#peek() === "]") {
				this.#pos += 1;
				return items;
			}
			items.push(this.#parseValue());
			this.#skipArrayWhitespace();
			if (this.#peek() === ",") {
				this.#pos += 1;
				continue;
			}
			if (this.#peek() === "]") {
				this.#pos += 1;
				return items;
			}
			throw this.#errorAt("数组元素之间需要逗号", start);
		}
	}

	#parseInlineTable(): ConfigTable {
		const start = this.#pos;
		this.#pos += 1;
		const table: ConfigTable = {};

		this.#skipHorizontalWhitespace();
		if (this.#peek() === "}") {
			this.#pos += 1;
			return table;
		}

		for (;;) {
			this.#skipHorizontalWhitespace();
			if (this.#atNewline() || this.#atEnd()) {
				throw this.#error("内联表不能跨行，且必须以 } 结束");
			}
			const path = this.#parseKeyPath();
			this.#skipHorizontalWhitespace();
			this.#expectCharacter("=", "键之后需要等号");
			this.#skipHorizontalWhitespace();
			this.#assign(table, path, this.#parseValue());
			this.#skipHorizontalWhitespace();

			if (this.#peek() === ",") {
				this.#pos += 1;
				continue;
			}
			if (this.#peek() === "}") {
				this.#pos += 1;
				return table;
			}
			throw this.#errorAt("内联表里只允许用逗号分隔键值对，且不能跨行", start);
		}
	}

	/** 收尾一行：只允许空白与注释，随后必须是换行或文件结尾。 */
	#finishLine(context: string): void {
		this.#skipHorizontalWhitespace();
		if (this.#atComment()) this.#skipToLineEnd();
		if (this.#atEnd()) return;
		if (!this.#atNewline()) throw this.#error(`${context}之后只能跟换行`);
		this.#consumeNewline();
	}

	#skipHorizontalWhitespace(): void {
		while (this.#pos < this.#source.length) {
			const char = this.#source[this.#pos];
			if (char !== " " && char !== "\t") return;
			this.#pos += 1;
		}
	}

	#skipArrayWhitespace(): void {
		for (;;) {
			this.#skipHorizontalWhitespace();
			if (this.#atComment()) {
				this.#skipToLineEnd();
				continue;
			}
			if (this.#atNewline()) {
				this.#consumeNewline();
				continue;
			}
			return;
		}
	}

	#skipToLineEnd(): void {
		while (this.#pos < this.#source.length) {
			const char = this.#source[this.#pos];
			if (char === "\n") return;
			this.#pos += 1;
		}
	}

	#atComment(): boolean {
		return this.#peek() === "#";
	}

	#atNewline(): boolean {
		return this.#peek() === "\n" || (this.#peek() === "\r" && this.#peekAt(1) === "\n");
	}

	#consumeNewline(): void {
		if (this.#peek() === "\r") this.#pos += 1;
		this.#pos += 1;
	}

	#atEnd(): boolean {
		return this.#pos >= this.#source.length;
	}

	#peek(): string | undefined {
		return this.#peekAt(0);
	}

	#peekAt(offset: number): string | undefined {
		return this.#source[this.#pos + offset];
	}

	#startsWith(text: string): boolean {
		return this.#source.startsWith(text, this.#pos);
	}

	#expectCharacter(expected: string, message: string): void {
		if (this.#peek() !== expected) throw this.#error(message);
		this.#pos += 1;
	}

	#expectText(expected: string, message: string): void {
		if (!this.#startsWith(expected)) throw this.#error(message);
		this.#pos += expected.length;
	}

	#error(message: string): ConfigError {
		return this.#errorAt(message, this.#pos);
	}

	#errorAt(message: string, offset: number): ConfigError {
		return new ConfigError(message, offsetToLineColumn(this.#source, offset));
	}
}
