import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { ConfigError, offsetToLineColumn, type LineColumn } from "#src/config/error.ts";
import { setTableValue, type ConfigTable, type ConfigValue } from "#src/config/value.ts";

/**
 * jsonc-parser 的错误码数值。
 *
 * 库把它发布成 const enum：编译产物里没有这个对象，运行时拿不到，只能按数值比对。
 * 数值与库的 ParseErrorCode 一一对应，升级库时若报错行为变化，先核对这里。
 */
const CODE_INVALID_SYMBOL = 1;
const CODE_INVALID_NUMBER_FORMAT = 2;
const CODE_PROPERTY_NAME_EXPECTED = 3;
const CODE_VALUE_EXPECTED = 4;
const CODE_COLON_EXPECTED = 5;
const CODE_COMMA_EXPECTED = 6;
const CODE_CLOSE_BRACE_EXPECTED = 7;
const CODE_CLOSE_BRACKET_EXPECTED = 8;
const CODE_END_OF_FILE_EXPECTED = 9;
const CODE_UNEXPECTED_END_OF_COMMENT = 11;
const CODE_UNEXPECTED_END_OF_STRING = 12;
const CODE_UNEXPECTED_END_OF_NUMBER = 13;
const CODE_INVALID_UNICODE = 14;
const CODE_INVALID_ESCAPE_CHARACTER = 15;
const CODE_INVALID_CHARACTER = 16;

/** JSON 与 TOML 共用同一套值模型。 */
type JsonValue = ConfigValue;
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
 * JSON 解析器：JSONC（标准 JSON 加行/块注释）。
 *
 * 解析本体交给 jsonc-parser，这里从语法树重建库不直接给的两样东西——值树用本项目的
 * 安全写键逻辑组装（`__proto__` 仍是普通键，不改写原型），位置索引让校验错误能像 TOML
 * 那侧一样指到行列。库的错误码翻译回 ConfigError，报错格式与手写时期保持一致。
 *
 * 相对标准 JSON 的两处收紧与配置文件的用途一致：
 * - 拒绝重复的键。标准允许重复而取最后一个，这在配置文件里几乎总是笔误，静默覆盖会让人
 *   以为自己设的那一项没生效。
 * - 拒绝尾随逗号。少写一项时宁可报错，不要让「看起来写完了」的配置悄悄生效。
 */
export class JsonParser {
	readonly #source: string;

	constructor(source: string) {
		this.#source = source;
	}

	parse(): JsonParseResult {
		if (this.#source.trim().length === 0) {
			throw this.#error("Empty file; expected a JSON object", 0);
		}

		const errors: ParseError[] = [];
		const tree = parseTree(this.#source, errors, { allowTrailingComma: false });
		if (tree === undefined) {
			// 只剩注释（或只有空白）的文件也没有顶层值：按空文件报，错误码只是「缺值」
			const onlyMissingValue = errors.every((item) => item.error === CODE_VALUE_EXPECTED);
			const first = errors[0];
			if (first === undefined || onlyMissingValue) {
				throw this.#error("Empty file; expected a JSON object", first?.offset ?? 0);
			}
			throw this.#toError(first);
		}
		if (errors.length > 0) throw this.#toError(errors[0], tree);

		const locations = new Map<string, LineColumn>();
		const value = this.#fromNode(tree, [], locations);
		return { value, locations };
	}

	/** 把语法树转成值树，顺手记录每个键与数组元素的位置、拒绝重复键。 */
	#fromNode(
		node: Node,
		path: readonly (string | number)[],
		locations: Map<string, LineColumn>,
	): JsonValue {
		switch (node.type) {
			case "object": {
				const table: ConfigTable = {};
				for (const property of node.children ?? []) {
					const keyNode = property.children?.[0];
					const valueNode = property.children?.[1];
					const key = keyNode?.value;
					if (typeof key !== "string" || valueNode === undefined) {
						// 库保证对象的孩子都是完整属性节点，缺结构说明遇到没覆盖到的语法，
						// 按最保守一侧拒绝，不让半理解的配置生效
						throw this.#error("Malformed object syntax", property.offset);
					}
					if (Object.hasOwn(table, key)) {
						throw this.#errorAt(`Duplicate key ${key}`, property.offset);
					}
					locations.set(jsonPathKey([...path, key]), offsetToLineColumn(this.#source, property.offset));
					setTableValue(table, key, this.#fromNode(valueNode, [...path, key], locations));
				}
				return table;
			}
			case "array": {
				const items: ConfigValue[] = [];
				(node.children ?? []).forEach((item, index) => {
					locations.set(jsonPathKey([...path, index]), offsetToLineColumn(this.#source, item.offset));
					items.push(this.#fromNode(item, [...path, index], locations));
				});
				return items;
			}
			case "string": {
				const value: unknown = node.value;
				if (typeof value !== "string") throw this.#error("Malformed string", node.offset);
				return value;
			}
			case "number": {
				const value: unknown = node.value;
				if (typeof value !== "number" || !Number.isFinite(value)) {
					throw this.#error("Malformed number", node.offset);
				}
				return value;
			}
			case "boolean": {
				const value: unknown = node.value;
				if (typeof value !== "boolean") throw this.#error("Malformed boolean", node.offset);
				return value;
			}
			case "null":
				return null;
			default:
				throw this.#error("Unrecognized value", node.offset);
		}
	}

	#toError(error: ParseError, tree?: Node): ConfigError {
		return this.#errorAt(describeParseError(this.#source, error, tree), error.offset);
	}

	#error(message: string, offset: number): ConfigError {
		return this.#errorAt(message, offset);
	}

	#errorAt(message: string, offset: number): ConfigError {
		return new ConfigError(message, offsetToLineColumn(this.#source, offset));
	}
}

/** 从错误位置往前找最近的非空白字符。 */
function previousCharacter(source: string, offset: number): string | undefined {
	let index = offset - 1;
	while (index >= 0 && /\s/.test(source[index] ?? "")) index -= 1;
	return source[index];
}

/** 库的错误码翻译成人话；翻译不了的就描述「这一段有问题」。 */
function describeParseError(source: string, error: ParseError, tree?: Node): string {
	// 尾随逗号在「缺成员/缺值」这两个码上报出来：错误位置顶着被逗号多余的收括号
	const trailing =
		(error.error === CODE_PROPERTY_NAME_EXPECTED || error.error === CODE_VALUE_EXPECTED)
			? trailingCommaAt(source, error.offset)
			: undefined;
	if (trailing !== undefined) return `Unexpected trailing comma in ${trailing}`;

	// 顶层值已经完整、错误落在它之后：是多了内容，而不是这个词认不出来
	if (error.error === CODE_INVALID_SYMBOL && tree !== undefined) {
		if (error.offset >= tree.offset + tree.length) {
			return "Unexpected content after the top-level value";
		}
	}

	switch (error.error) {
		case CODE_INVALID_SYMBOL: {
			const raw = source.slice(error.offset, error.offset + Math.max(1, error.length));
			return `Unrecognized value ${raw}`;
		}
		case CODE_INVALID_NUMBER_FORMAT:
		case CODE_UNEXPECTED_END_OF_NUMBER:
			return "Malformed number";
		case CODE_PROPERTY_NAME_EXPECTED:
			return "Expected a property name";
		case CODE_VALUE_EXPECTED:
			return "Missing value";
		case CODE_COLON_EXPECTED:
			return "Expected a colon after the key";
		case CODE_COMMA_EXPECTED:
			return "Members must be separated by commas";
		case CODE_CLOSE_BRACE_EXPECTED:
			return "Unterminated object; missing }";
		case CODE_CLOSE_BRACKET_EXPECTED:
			return "Unterminated array; missing ]";
		case CODE_END_OF_FILE_EXPECTED:
			return "Unexpected content after the top-level value";
		case CODE_UNEXPECTED_END_OF_COMMENT:
			return "Unterminated block comment";
		case CODE_UNEXPECTED_END_OF_STRING:
			return "Unterminated string";
		case CODE_INVALID_UNICODE:
			return "\\u escape needs 4 hex digits";
		case CODE_INVALID_ESCAPE_CHARACTER: {
			const escape = source.slice(error.offset, error.offset + 2);
			return `Unsupported escape ${escape}`;
		}
		case CODE_INVALID_CHARACTER:
			return "Raw control character in string";
		default:
			return "Invalid JSON syntax";
	}
}

/** 错误位置是否顶着尾随逗号；是则返回它所在的容器种类。 */
function trailingCommaAt(source: string, offset: number): "object" | "array" | undefined {
	if (previousCharacter(source, offset) !== ",") return undefined;
	const closer = source[offset];
	if (closer === "}") return "object";
	if (closer === "]") return "array";
	return undefined;
}
