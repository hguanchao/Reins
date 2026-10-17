/**
 * 工具参数的 JSON Schema 子集。
 *
 * 只保留模型能稳定生成的构造：字符串、数字、整数、布尔、数组、对象，外加枚举与描述。
 * 组合关键字（anyOf、oneOf、$ref）不做：它们既容易让模型写出偏掉的参数，也让校验错误的
 * 提示变得含糊；真需要那种表达力时，正确做法是拆成多个工具。
 */

export type JsonSchema =
	| { readonly type: "string"; readonly description?: string; readonly enum?: readonly string[] }
	| { readonly type: "number"; readonly description?: string }
	| { readonly type: "integer"; readonly description?: string; readonly minimum?: number }
	| { readonly type: "boolean"; readonly description?: string }
	| { readonly type: "array"; readonly description?: string; readonly items: JsonSchema }
	| {
			readonly type: "object";
			readonly description?: string;
			readonly properties: Readonly<Record<string, JsonSchema>>;
			readonly required?: readonly string[];
	  };

export interface ValidationFailure {
	readonly ok: false;
	/** 面向模型的问题清单，逐项写明路径、期望与实际收到的内容 */
	readonly message: string;
}

export interface ValidationSuccess {
	readonly ok: true;
	readonly value: Record<string, unknown>;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		case "undefined":
			return "undefined";
		default:
			return typeof value;
	}
}

/** 值是否符合模式；返回问题描述，符合则返回 undefined。 */
function check(schema: JsonSchema, value: unknown, path: string, problems: string[]): void {
	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") {
				problems.push(`${path} must be a string, got ${describeType(value)}`);
				return;
			}
			if (schema.enum !== undefined && !schema.enum.some((item) => item === value)) {
				problems.push(`${path} must be one of ${schema.enum.join(", ")}, got ${JSON.stringify(value)}`);
			}
			return;
		}
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				problems.push(`${path} must be a number, got ${describeType(value)}`);
			}
			return;
		}
		case "integer": {
			if (typeof value !== "number" || !Number.isInteger(value)) {
				problems.push(`${path} must be an integer, got ${describeType(value)}`);
				return;
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				problems.push(`${path} must be at least ${schema.minimum}, got ${value}`);
			}
			return;
		}
		case "boolean": {
			if (typeof value !== "boolean") {
				problems.push(`${path} must be a boolean, got ${describeType(value)}`);
			}
			return;
		}
		case "array": {
			if (!Array.isArray(value)) {
				problems.push(`${path} must be an array, got ${describeType(value)}`);
				return;
			}
			for (let index = 0; index < value.length; index += 1) {
				check(schema.items, value[index], `${path}[${index}]`, problems);
			}
			return;
		}
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				problems.push(`${path} must be an object, got ${describeType(value)}`);
				return;
			}
			const record = value as Record<string, unknown>;
			for (const key of schema.required ?? []) {
				if (record[key] === undefined) problems.push(`${path} is missing the required key ${key}`);
			}
			// 没有声明 properties 时任何键都合法。本程序自带的工具都会声明，但参数模式也可能
			// 来自外部（远端工具），只说 type 不列属性是合法的 JSON Schema 写法
			const properties = schema.properties;
			if (properties === undefined) return;
			for (const [key, item] of Object.entries(record)) {
				const property = properties[key];
				if (property === undefined) {
					// 多余的键一律报错：多半是模型把参数名写错了，静默忽略会让它以为设置生效了
					problems.push(`${path} has an unknown key ${key}; valid keys: ${Object.keys(properties).join(", ")}`);
					continue;
				}
				if (item === undefined) continue;
				check(property, item, `${path === "" ? "" : `${path}.`}${key}`, problems);
			}
			return;
		}
	}
}

/**
 * 校验工具参数。
 *
 * 只做类型与必填检查，不做类型转换：模型把整数写成字符串时宁可让它改一次，也不要猜它的
 * 意图——猜错会执行出一个使用者没要求的动作。确实需要容忍的畸形写法（比如编辑工具历史上
 * 收到过的字符串化数组）由各工具的 prepareArguments 单独处理。
 */
export function validateToolArguments(schema: JsonSchema, args: unknown): ValidationResult {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { ok: false, message: `Arguments must be an object, got ${describeType(args)}` };
	}

	const problems: string[] = [];
	check(schema, args, "", problems);
	if (problems.length > 0) return { ok: false, message: problems.join("\n") };
	return { ok: true, value: args as Record<string, unknown> };
}
