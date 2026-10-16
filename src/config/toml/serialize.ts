import { isConfigArray, isConfigTable, type ConfigValue } from "../value.ts";

/** 基本字符串需要转义的字符。字面量字符串里出现的这些字符只能靠转义表达，所以统一用基本字符串输出。 */
const ESCAPES: ReadonlyMap<string, string> = new Map([
	["\u0008", "\\b"],
	["\t", "\\t"],
	["\n", "\\n"],
	["\f", "\\f"],
	["\r", "\\r"],
	["\u0022", '\\"'],
	["\u005c", "\\\\"],
]);

/** TOML 的裸键只允许这几类字符，其余情况必须加引号。 */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function quoteBasic(input: string): string {
	let out = '"';
	for (const char of input) {
		const escaped = ESCAPES.get(char);
		if (escaped !== undefined) {
			out += escaped;
			continue;
		}
		// 控制字符无法直接出现在基本字符串里，补成 \uXXXX
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
			continue;
		}
		out += char;
	}
	return out + '"';
}

function formatNumber(value: number): string {
	if (Number.isNaN(value)) return "nan";
	if (value === Number.POSITIVE_INFINITY) return "inf";
	if (value === Number.NEGATIVE_INFINITY) return "-inf";
	// 整数与浮点在 JS 里同属 number，这里按整数值输出；需要浮点语义的调用方应写入带小数点的值
	return String(value);
}

/** 把键写成可以直接放进赋值语句左侧或表头里的形式。 */
export function serializeKey(key: string): string {
	return BARE_KEY.test(key) ? key : quoteBasic(key);
}

/** 把值写成 TOML 字面量。表输出为内联表，用于写回单个键的值。 */
export function serializeValue(value: ConfigValue): string {
	if (typeof value === "string") return quoteBasic(value);
	if (typeof value === "number") return formatNumber(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (isConfigArray(value)) return `[${value.map(serializeValue).join(", ")}]`;
	if (isConfigTable(value)) {
		const pairs = Object.entries(value).map(
			([key, item]) => `${serializeKey(key)} = ${serializeValue(item)}`,
		);
		return `{ ${pairs.join(", ")} }`;
	}
	// ConfigValue 的联合类型已经穷尽，走到这里说明调用方绕过了类型检查
	throw new TypeError("无法序列化的值");
}
