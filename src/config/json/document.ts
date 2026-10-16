import type { LineColumn } from "../config-error.ts";
import type { ConfigSource } from "../reader.ts";
import { isConfigTable, type ConfigPath, type ConfigValue } from "../value.ts";
import { JsonParser, jsonPathKey } from "./parser.ts";

/**
 * 带位置索引的 JSON 文档。
 *
 * 只负责读：模型配置是纯声明，不需要程序回写，因此不提供 set。位置索引的意义在于让
 * 校验错误能指到具体行列，与 TOML 那侧的报错格式一致。
 */
export class JsonDocument implements ConfigSource {
	#value: ConfigValue = null;
	#locations: ReadonlyMap<string, LineColumn> = new Map();

	constructor(source: string) {
		const parsed = new JsonParser(source).parse();
		this.#value = parsed.value;
		this.#locations = parsed.locations;
	}

	get value(): ConfigValue {
		return this.#value;
	}

	/** 按键路径取值；路径上任何一段类型不符、或键不存在，都返回 undefined。 */
	get(path: ConfigPath): ConfigValue | undefined {
		let current: ConfigValue | undefined = this.#value;
		for (const part of path) {
			if (current === undefined || current === null) return undefined;
			if (Array.isArray(current)) {
				if (typeof part !== "number") return undefined;
				current = current[part];
				continue;
			}
			if (!isConfigTable(current) || typeof part !== "string") return undefined;
			current = current[part];
		}
		return current;
	}

	locationOf(path: ConfigPath): LineColumn | undefined {
		return this.#locations.get(jsonPathKey(path));
	}
}
