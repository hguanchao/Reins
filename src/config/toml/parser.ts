import { ConfigError, offsetToLineColumn } from "../config-error.ts";
import {
	hasTableKey,
	isConfigTable,
	setTableValue,
	tableValue,
	type ConfigTable,
	type ConfigValue,
} from "../value.ts";

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

// 数字的组成规则直接写进正则，而不是先去掉下划线再校验：下划线只能夹在数字之间，
// 先去掉就再也看不出 1_ 或 1__0 这类写法错在哪了。
const INTEGER_PART = "(?:0|[1-9](?:_?\\d)*)";
const DIGIT_PART = "\\d(?:_?\\d)*";
const DECIMAL_INTEGER = new RegExp(`^[+-]?${INTEGER_PART}$`);
const FLOAT_WITH_FRACTION = new RegExp(`^[+-]?${INTEGER_PART}\\.${DIGIT_PART}(?:[eE][+-]?${DIGIT_PART})?$`);
const FLOAT_WITH_EXPONENT = new RegExp(`^[+-]?${INTEGER_PART}[eE][+-]?${DIGIT_PART}$`);
const SPECIAL_FLOAT = /^[+-]?(inf|nan)$/;
// 非十进制整数不允许带符号，这是 TOML 的明确规定
const HEX_INTEGER = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCT_INTEGER = /^0o[0-7](?:_?[0-7])*$/;
const BIN_INTEGER = /^0b[01](?:_?[01])*$/;

/** 容器是怎么产生的，决定它之后还能不能被继续写入。 */
type ContainerState =
	/** 表头路径穿过的表：可以被之后的表头补成显式定义 */
	| "implicit"
	/** 赋值里的点分键建出来的表：不能再被表头定义 */
	| "dotted"
	/** 已被表头定义过：不能再定义第二次，也不能用点分键往里追加 */
	| "explicit"
	/** [[...]] 建出来的数组表：可以继续追加元素 */
	| "table-array"
	/** 内联表与字面量数组：写出来就是完整的，之后不能再添加内容 */
	| "closed";

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
	/** 每个表与数组是怎么来的，见 ContainerState */
	readonly #tableStates = new WeakMap<object, ContainerState>();

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
				this.#finishLine("table header");
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
			this.#expectCharacter("=", "Expected an equals sign after the key");
			this.#skipHorizontalWhitespace();
			const valueStart = this.#pos;
			const value = this.#parseValue();
			const valueEnd = this.#pos;
			this.#assign(table, path, value, pathStart);
			// 记录完整路径：解析用的是相对当前表的键，但回写要按完整路径才能定位到这一行
			assignments.push({
				path: section.path === null ? path : [...section.path, ...path],
				pathStart,
				valueStart,
				valueEnd,
			});

			this.#finishLine("assignment");
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
			this.#expectText("]]", "Array of tables header must end with ]]");
		} else {
			this.#expectText("]", "Table header must end with ]");
		}
		return { path, table: this.#defineTable(root, path, isArrayOfTables, start), isArrayOfTables };
	}

	/**
	 * 从根出发沿路径下行，返回路径末端所在的表。
	 *
	 * 表头与点分键的下行规则不同，所以由 traversal 决定两件事：中途缺表时建出的表算哪种
	 * （表头路径穿过的表可以被之后的表头补成显式定义），以及能不能穿过已显式定义过的表。
	 * 表头可以穿过——`[a]` 之后再写 `[a.b]` 是合法的；点分键不行，那等于两处语法同时改写同一个表。
	 *
	 * 另有两条禁止往里走的规则：内联表与字面量数组一旦写出来就是完整的，之后不能再添加内容。
	 */
	#descend(
		root: ConfigTable,
		path: readonly string[],
		start: number,
		traversal: "header" | "dotted",
	): ConfigTable {
		let table = root;
		for (let index = 0; index < path.length; index += 1) {
			const key = path[index];
			const where = path.slice(0, index + 1).join(".");
			const existing = tableValue(table, key);
			if (existing === undefined) {
				const created: ConfigTable = {};
				setTableValue(table, key, created);
				this.#tableStates.set(created, traversal === "header" ? "implicit" : "dotted");
				table = created;
				continue;
			}
			if (isConfigTable(existing)) {
				const state = this.#tableStates.get(existing);
				if (state === "closed") {
					throw this.#errorAt(`${where} is an inline table and cannot be extended`, start);
				}
				if (state === "explicit" && traversal === "dotted") {
					throw this.#errorAt(`${where} was already defined by a table header and cannot be extended with dotted keys`, start);
				}
				table = existing;
				continue;
			}
			if (Array.isArray(existing)) {
				if (this.#tableStates.get(existing) !== "table-array") {
						throw this.#errorAt(`${where} is an array and cannot be used as a table`, start);
				}
				// 数组表上的子表挂在最后一个元素下。这条只对表头成立：点分键往数组表里追加
				// 会让「数组有几个元素」取决于写法，读的时候拼不出最终形态。
				if (traversal === "dotted") {
						throw this.#errorAt(`${where} is an array of tables and cannot be extended with dotted keys`, start);
				}
				table = existing[existing.length - 1] as ConfigTable;
				continue;
			}
			throw this.#errorAt(`${where} is already taken by a non-table value`, start);
		}
		return table;
	}

	/** 表头落位。隐式的父表可以在这里被补成显式，其余情况重复定义一律报错。 */
	#defineTable(
		root: ConfigTable,
		path: readonly string[],
		isArrayOfTables: boolean,
		start: number,
	): ConfigTable {
		const parent = this.#descend(root, path.slice(0, -1), start, "header");
		const last = path[path.length - 1];
		const existing = tableValue(parent, last);

		if (isArrayOfTables) {
			if (existing === undefined) {
				const created: ConfigTable = {};
				const array = [created];
				setTableValue(parent, last, array);
				this.#tableStates.set(array, "table-array");
				this.#tableStates.set(created, "explicit");
				return created;
			}
			if (Array.isArray(existing) && this.#tableStates.get(existing) === "table-array") {
				const appended: ConfigTable = {};
				existing.push(appended);
				this.#tableStates.set(appended, "explicit");
				return appended;
			}
			throw this.#errorAt(`Array of tables ${path.join(".")} conflicts with an existing definition`, start);
		}

		if (existing === undefined) {
			const created: ConfigTable = {};
			setTableValue(parent, last, created);
			this.#tableStates.set(created, "explicit");
			return created;
		}
		if (isConfigTable(existing) && this.#tableStates.get(existing) === "implicit") {
			this.#tableStates.set(existing, "explicit");
			return existing;
		}
		if (Array.isArray(existing)) {
			throw this.#errorAt(`${path.join(".")} is already defined as an array of tables`, start);
		}
		throw this.#errorAt(`Duplicate definition of table ${path.join(".")}`, start);
	}

	/** 把值写进当前表；点分键会展开成嵌套的表，这类表之后不能再被表头定义。 */
	#assign(table: ConfigTable, path: readonly string[], value: ConfigValue, start: number): void {
		const target = this.#descend(table, path.slice(0, -1), start, "dotted");
		const last = path[path.length - 1];
		if (hasTableKey(target, last)) {
			throw this.#errorAt(`Duplicate key ${path.join(".")}`, start);
		}
		setTableValue(target, last, value);
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
		if (this.#pos === start) throw this.#error("Missing key name");
		return this.#source.slice(start, this.#pos);
	}

	#parseValue(): ConfigValue {
		const char = this.#peek();
		if (char === undefined) throw this.#error("Missing value");
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
		if (raw.length === 0) throw this.#errorAt("Missing value", start);
		if (raw === "true") return true;
		if (raw === "false") return false;
		if (raw.includes(":")) throw this.#errorAt("Time values are not supported", start);
		if (/^\d{4}-\d{2}-\d{2}/.test(raw)) throw this.#errorAt("Date values are not supported", start);
		return this.#parseNumber(raw, start);
	}

	#parseNumber(raw: string, start: number): number {
		if (SPECIAL_FLOAT.test(raw)) {
			const negative = raw.startsWith("-");
			if (raw.includes("inf")) return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
			return Number.NaN;
		}
		if (HEX_INTEGER.test(raw)) return Number.parseInt(raw.slice(2).replaceAll("_", ""), 16);
		if (OCT_INTEGER.test(raw)) return Number.parseInt(raw.slice(2).replaceAll("_", ""), 8);
		if (BIN_INTEGER.test(raw)) return Number.parseInt(raw.slice(2).replaceAll("_", ""), 2);

		const digitsOnly = raw.replaceAll("_", "");
		if (DECIMAL_INTEGER.test(raw)) return Number.parseInt(digitsOnly, 10);
		if (FLOAT_WITH_FRACTION.test(raw) || FLOAT_WITH_EXPONENT.test(raw)) {
			return Number.parseFloat(digitsOnly);
		}
		throw this.#errorAt(`Unrecognized value ${raw}`, start);
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
			if (char === undefined) throw this.#errorAt("Unterminated string", start);
			if (char === "\n" || char === "\r") throw this.#errorAt("Basic string cannot span lines", start);
			if (char === '"') {
				this.#pos += 1;
				return out;
			}
			if (char === "\\") {
				out += this.#readEscape();
				continue;
			}
			this.#assertTextCharacter(char, false);
			out += char;
			this.#pos += 1;
		}
	}

	#readMultilineBasic(start: number): string {
		// 紧跟开定界符的换行是排版用的，不算内容
		if (this.#atNewline()) this.#consumeNewline();

		let out = "";
		for (;;) {
			if (this.#atEnd()) throw this.#errorAt("Unterminated multiline string", start);

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
				if (quotes > 5) throw this.#errorAt("Too many quotes in multiline string", start);
				out += '"'.repeat(quotes - 3);
				this.#pos += quotes;
				return out;
			}

			this.#assertTextCharacter(this.#source[this.#pos], true);
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
			if (char === undefined) throw this.#errorAt("Unterminated string", start);
			if (char === "\n" || char === "\r") throw this.#errorAt("Literal string cannot span lines", start);
			if (char === "'") {
				this.#pos += 1;
				return out;
			}
			this.#assertTextCharacter(char, false);
			out += char;
			this.#pos += 1;
		}
	}

	#readMultilineLiteral(start: number): string {
		if (this.#atNewline()) this.#consumeNewline();

		let out = "";
		for (;;) {
			if (this.#atEnd()) throw this.#errorAt("Unterminated multiline string", start);
			if (this.#startsWith("'''")) {
				let quotes = 0;
				while (this.#peekAt(quotes) === "'") quotes += 1;
				if (quotes > 5) throw this.#errorAt("Too many quotes in multiline string", start);
				out += "'".repeat(quotes - 3);
				this.#pos += quotes;
				return out;
			}
			this.#assertTextCharacter(this.#source[this.#pos], true);
			out += this.#source[this.#pos];
			this.#pos += 1;
		}
	}

	#readEscape(): string {
		const start = this.#pos;
		this.#pos += 1;
		const char = this.#peek();
		if (char === undefined) throw this.#errorAt("Missing escape sequence", start);
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
				throw this.#errorAt(`Unsupported escape \\${char}`, start);
		}
	}

	#readUnicodeEscape(digits: number, start: number): string {
		const hex = this.#source.slice(this.#pos, this.#pos + digits);
		if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
			throw this.#errorAt(`Unicode escape needs ${digits} hex digits`, start);
		}
		this.#pos += digits;
		const code = Number.parseInt(hex, 16);
		// 代理区不是有效码位，放行会得到无法编码的半个字符
		if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
			throw this.#errorAt("Unicode escape must be a valid code point", start);
		}
		return String.fromCodePoint(code);
	}

	#parseArray(): ConfigValue[] {
		const start = this.#pos;
		this.#pos += 1;
		const items: ConfigValue[] = [];

		for (;;) {
			this.#skipArrayWhitespace();
			if (this.#atEnd()) throw this.#errorAt("Unterminated array", start);
			if (this.#peek() === "]") {
				this.#pos += 1;
				this.#closeContainer(items);
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
				this.#closeContainer(items);
				return items;
			}
			throw this.#errorAt("Expected a comma between array elements", start);
		}
	}

	#parseInlineTable(): ConfigTable {
		const start = this.#pos;
		this.#pos += 1;
		const table: ConfigTable = {};

		this.#skipHorizontalWhitespace();
		if (this.#peek() === "}") {
			this.#pos += 1;
			this.#closeContainer(table);
			return table;
		}

		for (;;) {
			this.#skipHorizontalWhitespace();
			if (this.#atNewline() || this.#atEnd()) {
				throw this.#error("Inline table cannot span lines and must end with }");
			}
			const keyStart = this.#pos;
			const path = this.#parseKeyPath();
			this.#skipHorizontalWhitespace();
			this.#expectCharacter("=", "Expected an equals sign after the key");
			this.#skipHorizontalWhitespace();
			this.#assign(table, path, this.#parseValue(), keyStart);
			this.#skipHorizontalWhitespace();

			if (this.#peek() === ",") {
				this.#pos += 1;
				continue;
			}
			if (this.#peek() === "}") {
				this.#pos += 1;
				this.#closeContainer(table);
				return table;
			}
			throw this.#errorAt("Inline table members must be comma-separated and cannot span lines", start);
		}
	}

	/**
	 * 内联表与字面量数组写出来就是完整的。
	 *
	 * 之后任何语法都不该再往里添加内容：允许的话，同一个容器会被两处互相不知道的写法同时
	 * 改写，读起来要跳好几屏才能拼出最终形态。
	 */
	#closeContainer(container: ConfigTable | ConfigValue[]): void {
		this.#tableStates.set(container, "closed");
	}

	/** 收尾一行：只允许空白与注释，随后必须是换行或文件结尾。 */
	#finishLine(context: string): void {
		this.#skipHorizontalWhitespace();
		if (this.#atComment()) this.#skipToLineEnd();
		if (this.#atEnd()) return;
			if (!this.#atNewline()) throw this.#error(`Only a newline may follow the ${context}`);
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
			// CRLF 里的 \r 属于行尾而不是注释内容，留给 #consumeNewline 处理
			if (char === "\r" && this.#peekAt(1) === "\n") return;
			this.#assertTextCharacter(char, false);
			this.#pos += 1;
		}
	}

	/**
	 * 断言一个字符可以出现在注释或字符串里。
	 *
	 * 控制字符在 TOML 里是禁止的：它们让「这一行到底写了什么」变得不可靠，同一个配置在不同
	 * 终端上显示得也不一样。tab 在注释与字符串里都允许；换行只在多行字符串里允许，
	 * 且必须成对出现（CRLF）或为 LF，单独的 CR 不算换行。
	 */
	#assertTextCharacter(char: string, allowNewline: boolean): void {
		const code = char.codePointAt(0) ?? 0;
		if (code > 0x1f && code !== 0x7f) return;
		if (char === "\t") return;
		if (allowNewline && (char === "\n" || (char === "\r" && this.#peekAt(1) === "\n"))) return;
		throw this.#error(`Control character U+${code.toString(16).toUpperCase().padStart(4, "0")} is not allowed`);
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
