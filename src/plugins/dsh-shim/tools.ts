import { isObject } from "./shared.ts";

/**
 * `@deepseek-ai/dsh-tools` 的替身。
 *
 * dsh 插件用它声明工具；npm 上有真包，插件安装时会一并装上，这里的替身只在依赖缺失时兜底。
 * 两者产物形状一致：`{ name, description, parameters(JSON Schema), execute(args, exec), output }`，
 * 这样宿主的适配层不用区分工具来自哪一边。
 *
 * 替身不做参数校验——真包的 defineTool 会按 schema 校验，兜底路径省略它，插件自己的边界
 * 检查仍然生效。
 */

/** dsh 的参数声明（字段映射）转成标准 JSON Schema。 */
export function parameterSpecToJsonSchema(spec: unknown): Record<string, unknown> {
	if (!isObject(spec)) return { type: "object", properties: {} };

	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [name, field] of Object.entries(spec)) {
		properties[name] = fieldToSchema(field);
		if (isObject(field) && field["required"] === true) required.push(name);
	}
	return {
		type: "object",
		properties,
		...(required.length === 0 ? {} : { required }),
	};
}

function fieldToSchema(spec: unknown): unknown {
	if (!isObject(spec)) return spec;

	const { type, description, enum: values, items, properties, additionalProperties } = spec;
	const schema: Record<string, unknown> = {
		...(type === undefined ? {} : { type }),
		...(description === undefined ? {} : { description }),
		...(values === undefined ? {} : { enum: values }),
	};
	if (items !== undefined) schema["items"] = fieldToSchema(items);
	if (isObject(properties)) {
		const nested: Record<string, unknown> = {};
		const nestedRequired: string[] = [];
		for (const [name, field] of Object.entries(properties)) {
			nested[name] = fieldToSchema(field);
			if (isObject(field) && field["required"] === true) nestedRequired.push(name);
		}
		schema["properties"] = nested;
		if (nestedRequired.length > 0) schema["required"] = nestedRequired;
	}
	if (additionalProperties !== undefined) schema["additionalProperties"] = additionalProperties;
	return schema;
}

/** 工具被中止时的错误码；dsh 工具用它识别「调用方取消」。 */
export const TOOL_ABORTED = "tool_aborted";

/** 参数校验失败时抛出的错误；dsh 工具的调用方按名字识别它。 */
export class ToolArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolArgsError";
	}
}

/**
 * dsh 插件用 defineTool 声明工具：恒等包装加参数转换，校验留给真包。
 *
 * `required: true` 挂在字段上的写法在这里转成 JSON Schema 的 `required` 数组，宿主与真包
 * 看到的是同一份参数契约。
 */
export function defineTool(options: Record<PropertyKey, unknown>): Record<string, unknown> {
	return {
		name: options["name"],
		description: options["description"],
		parameters: parameterSpecToJsonSchema(options["parameters"]),
		output: options["output"],
		execute: options["execute"],
		...(options["presentCall"] === undefined ? {} : { presentCall: options["presentCall"] }),
		...(options["presentResult"] === undefined ? {} : { presentResult: options["presentResult"] }),
		...(options["timeoutMs"] === undefined ? {} : { timeoutMs: options["timeoutMs"] }),
	};
}
