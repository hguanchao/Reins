import { ConfigError, offsetToLineColumn, type LineColumn } from "../config-error.ts";
import type { ConfigTable, ConfigValue } from "../value.ts";

/** JSON 与 TOML 共用同一套值模型，见 config/value.ts。 */
export type JsonValue = ConfigValue;
export type JsonObject = ConfigTable;

export interface JsonParseResult {
	readonly value: JsonValue;
	/** 每个键与数组元素在原文中的位置；键是路径的 JSON 编码 */
	readonly locations: ReadonlyMap<string, LineColumn>;
}

/** 把键路径编码成 Map 的键。用 JSON 编码是为了避免分隔符与键名本身冲突。 */
export function jsonPathKey(path: readonly (string | number)[]): string {
	return JSON.stringify(path);
}

/**
 * JSON 解析器，额外记录每个键的位置。
 *
 * 相对标准 JSON 有两处有意偏离，都是为手写的配置文件服务：
 * - 允许行注释与块注释。需要临时停用某一项时，注释掉比删掉更安全。
 * - 拒绝重复的键。标准允许重复而取最后一个，这在配置文件里几乎总是笔误，静默覆盖会让人
 *   以为自己设的那一项没生效。
 *
 * 记录位置是为了让校验错误能像 TOML 那边一样指到行列，两种配置文件的报错体验保持一致。
 */
export class JsonParser {
	readonly #source: string;
	#pos = 0;
	readonly #locations = new Map<string, LineColumn>();

	constructor(source: string) {
		this.#source = source;
	}

	parse(): JsonParseResult {
		this.#skipTrivia();
		if (this.#atEnd()) throw this.#error("Empty file; expected a JSON object");
		const value = this.#parseValue([]);
		this.#skipTrivia();
		if (!this.#atEnd()) throw this.#error("Unexpected content after the top-level value");
		return { value, locations: this.#locations };
	}

	#parseValue(path: readonly (string | number)[]): JsonValue {
		const char = this.#peek();
		if (char === "{") return this.#parseObject(path);
		if (char === "[") return this.#parseArray(path);
		if (char === '"') return this.#parseString();
		return this.#parseLiteral();
	}

	#parseObject(path: readonly (string | number)[]): JsonObject {
		const start = this.#pos;
		this.#pos += 1;
		const result: JsonObject = {};

		this.#skipTrivia();
		if (this.#peek() === "}") {
			this.#pos += 1;
			return result;
		}

		for (;;) {
			this.#skipTrivia();
			const keyStart = this.#pos;
			// 能走到循环体里说明前面出现过逗号，此时遇到 } 就是多余的尾随逗号
			if (this.#peek() === "}") throw this.#error("Unexpected trailing comma in object");
			if (this.#peek() !== '"') throw this.#error("Object keys must be double-quoted strings");
			const key = this.#parseString();

			if (Object.hasOwn(result, key)) {
				throw this.#errorAt(`Duplicate key ${key}`, keyStart);
			}

			this.#skipTrivia();
			this.#expectCharacter(":", `Expected a colon after key ${key}`);
			this.#skipTrivia();

			this.#locations.set(jsonPathKey([...path, key]), offsetToLineColumn(this.#source, keyStart));
			result[key] = this.#parseValue([...path, key]);

			this.#skipTrivia();
			const char = this.#peek();
			if (char === ",") {
				this.#pos += 1;
				continue;
			}
			if (char === "}") {
				this.#pos += 1;
				return result;
			}
			throw this.#errorAt("Object members must be separated by commas", start);
		}
	}

	#parseArray(path: readonly (string | number)[]): JsonValue[] {
		const start = this.#pos;
		this.#pos += 1;
		const items: JsonValue[] = [];

		this.#skipTrivia();
		if (this.#peek() === "]") {
			this.#pos += 1;
			return items;
		}

		for (;;) {
			this.#skipTrivia();
			// 能走到循环体里说明前面出现过逗号，此时遇到 ] 就是多余的尾随逗号
			if (this.#peek() === "]") throw this.#error("Unexpected trailing comma in array");
			this.#locations.set(
				jsonPathKey([...path, items.length]),
				offsetToLineColumn(this.#source, this.#pos),
			);
			items.push(this.#parseValue([...path, items.length]));

			this.#skipTrivia();
			const char = this.#peek();
			if (char === ",") {
				this.#pos += 1;
				continue;
			}
			if (char === "]") {
				this.#pos += 1;
				return items;
			}
			throw this.#errorAt("Expected a comma between array elements", start);
		}
	}

	#parseString(): string {
		const start = this.#pos;
		this.#pos += 1;
		let out = "";

		for (;;) {
			const char = this.#peek();
			if (char === undefined) throw this.#errorAt("Unterminated string", start);
			if (char === '"') {
				this.#pos += 1;
				return out;
			}
			if (char === "\\") {
				out += this.#readEscape();
				continue;
			}
			if (char < " ") throw this.#errorAt("Raw control character in string", this.#pos);
			out += char;
			this.#pos += 1;
		}
	}

	#readEscape(): string {
		const escapeStart = this.#pos;
		this.#pos += 1;
		const char = this.#peek();
		if (char === undefined) throw this.#errorAt("Missing escape sequence", escapeStart);
		this.#pos += 1;

		switch (char) {
			case '"':
				return '"';
			case "\\":
				return "\\";
			case "/":
				return "/";
			case "b":
				return "\u0008";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "u": {
				const hex = this.#source.slice(this.#pos, this.#pos + 4);
				if (hex.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(hex)) {
					throw this.#errorAt("\\u escape needs 4 hex digits", escapeStart);
				}
				this.#pos += 4;
				return String.fromCharCode(Number.parseInt(hex, 16));
			}
			default:
					throw this.#errorAt(`Unsupported escape \\${char}`, escapeStart);
		}
	}

	#parseLiteral(): JsonValue {
		const start = this.#pos;
		while (!this.#atEnd()) {
			const char = this.#peek();
			if (
				char === "," ||
				char === "}" ||
				char === "]" ||
				char === " " ||
				char === "\t" ||
				char === "\n" ||
				char === "\r" ||
				char === "/"
			) {
				break;
			}
			this.#pos += 1;
		}

		const raw = this.#source.slice(start, this.#pos);
		if (raw === "true") return true;
		if (raw === "false") return false;
		if (raw === "null") return null;
		if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return Number.parseFloat(raw);

		if (raw.length === 0) throw this.#errorAt("Missing value", start);
		throw this.#errorAt(`Unrecognized value ${raw}`, start);
	}

	/** 跳过空白与注释。JSON 本身没有注释，这里是为了让手写的配置文件能临时停用某一项。 */
	#skipTrivia(): void {
		for (;;) {
			const char = this.#peek();
			if (char === " " || char === "\t" || char === "\n" || char === "\r") {
				this.#pos += 1;
				continue;
			}
			if (char === "/" && this.#peekAt(1) === "/") {
				while (!this.#atEnd() && this.#peek() !== "\n") this.#pos += 1;
				continue;
			}
			if (char === "/" && this.#peekAt(1) === "*") {
				const start = this.#pos;
				this.#pos += 2;
				for (;;) {
					if (this.#atEnd()) throw this.#errorAt("Unterminated block comment", start);
					if (this.#peek() === "*" && this.#peekAt(1) === "/") {
						this.#pos += 2;
						break;
					}
					this.#pos += 1;
				}
				continue;
			}
			return;
		}
	}

	#expectCharacter(expected: string, message: string): void {
		if (this.#peek() !== expected) throw this.#error(message);
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

	#error(message: string): ConfigError {
		return this.#errorAt(message, this.#pos);
	}

	#errorAt(message: string, offset: number): ConfigError {
		return new ConfigError(message, offsetToLineColumn(this.#source, offset));
	}
}
