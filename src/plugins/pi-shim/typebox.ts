/**
 * typebox 的最小替身。
 *
 * 扩展用它声明工具参数。它产出的就是 JSON Schema，所以这里只造结构，不做静态类型推导：
 * Reins 按 JSON Schema 校验参数，两边形状一致即可。
 *
 * `Optional` 是唯一的例外：JSON Schema 靠 `required` 表达可选，不是靠字段本身。这里用一个
 * symbol 挂在字段上，`Object` 收集完 required 后符号键会被 JSON 序列化自动忽略。
 */

const OPTIONAL = Symbol("reins.pi.optional");

type Schema = Record<PropertyKey, unknown>;

function scalar(type: string, options?: Schema): Schema {
	return { type, ...options };
}

function collection(type: string, member: unknown, options?: Schema): Schema {
	return { type, [type === "array" ? "items" : "additionalProperties"]: member, ...options };
}

export const Type = {
	Object(properties: Record<string, unknown>, options?: Schema): Schema {
		const required = Object.entries(properties)
			.filter(([, value]) => (value as Schema)[OPTIONAL] !== true)
			.map(([key]) => key);
		return {
			type: "object",
			properties,
			...(required.length === 0 ? {} : { required }),
			...options,
		};
	},
	String: (options?: Schema) => scalar("string", options),
	Number: (options?: Schema) => scalar("number", options),
	Integer: (options?: Schema) => scalar("integer", options),
	Boolean: (options?: Schema) => scalar("boolean", options),
	Null: (options?: Schema) => scalar("null", options),
	Any: (options?: Schema) => ({ ...options }),
	Unknown: (options?: Schema) => ({ ...options }),
	Array: (items: unknown, options?: Schema) => collection("array", items, options),
	Record: (key: unknown, value: unknown, options?: Schema) => ({
		type: "object",
		propertyNames: key,
		additionalProperties: value,
		...options,
	}),
	Union: (variants: readonly unknown[], options?: Schema) => ({ anyOf: variants, ...options }),
	Literal: (value: string | number | boolean | null, options?: Schema) => ({ const: value, ...options }),
	Enum: (values: readonly unknown[], options?: Schema) => ({ enum: values, ...options }),
	Optional(schema: unknown): Schema {
		return { ...(schema as Schema), [OPTIONAL]: true };
	},
};

/** 供 `StringEnum` 之类的外部封装使用：把一个值数组变成字符串枚举。 */
export function stringEnum(values: readonly string[], options?: Schema): Schema {
	return { type: "string", enum: values, ...options };
}
