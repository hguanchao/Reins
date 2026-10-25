import { ConfigError, type LineColumn } from "./error.ts";
import { isConfigTable, type ConfigPath, type ConfigTable, type ConfigValue } from "./value.ts";

/**
 * 配置读取器。
 *
 * 两个配置文件的语法不同，但「取一个值、类型不符就把错误指到那一行」这条规则完全一样，
 * 所以只实现一次，由读取器面向的文档对象决定值从哪来。这样两种配置文件的报错措辞与
 * 定位方式天然一致。
 */
export interface ConfigSource {
	get(path: ConfigPath): ConfigValue | undefined;
	locationOf(path: ConfigPath): LineColumn | undefined;
}

export function describePath(path: ConfigPath): string {
	return path.join(".");
}

/** 错误定位参数：文档能给出位置就带上，给不出就留空。 */
export function locate(source: ConfigSource, path: ConfigPath): { line?: number; column?: number } {
	return source.locationOf(path) ?? {};
}

/** 取表。路径存在但不是表时报错，避免把形式写错的键当成未设置。 */
export function readTable(source: ConfigSource, path: ConfigPath): ConfigTable | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (!isConfigTable(value)) {
		throw new ConfigError(`${describePath(path)} must be a table`, locate(source, path));
	}
	return value;
}

/** 表里的键必须是预期集合内的；拼错的键报错而不是忽略，否则使用者会以为设置生效了。 */
export function assertNoUnknownKeys(
	source: ConfigSource,
	tablePath: ConfigPath,
	allowed: readonly string[],
): void {
	const table = readTable(source, tablePath);
	if (table === undefined) return;

	for (const key of Object.keys(table)) {
		if (allowed.includes(key)) continue;
		throw new ConfigError(
			`Unknown key ${describePath([...tablePath, key])}; valid keys here: ${allowed.join(", ")}`,
			locate(source, [...tablePath, key]),
		);
	}
}

export function readString(source: ConfigSource, path: ConfigPath): string | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ConfigError(`${describePath(path)} must be a string`, locate(source, path));
	}
	return value;
}

export function readBoolean(source: ConfigSource, path: ConfigPath): boolean | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new ConfigError(`${describePath(path)} must be a boolean`, locate(source, path));
	}
	return value;
}

export function readInteger(source: ConfigSource, path: ConfigPath, minimum: number): number | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new ConfigError(`${describePath(path)} must be an integer`, locate(source, path));
	}
	if (value < minimum) {
		throw new ConfigError(`${describePath(path)} must be at least ${minimum}`, locate(source, path));
	}
	return value;
}

export function readNumber(source: ConfigSource, path: ConfigPath, minimum: number): number | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConfigError(`${describePath(path)} must be a number`, locate(source, path));
	}
	if (value < minimum) {
		throw new ConfigError(`${describePath(path)} must be at least ${minimum}`, locate(source, path));
	}
	return value;
}

export function readEnum<T extends string>(
	source: ConfigSource,
	path: ConfigPath,
	allowed: readonly T[],
): T | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !allowed.some((item) => item === value)) {
		throw new ConfigError(`${describePath(path)} must be one of ${allowed.join(", ")}`, locate(source, path));
	}
	return value as T;
}

/** 取值受限的字符串数组。重复项在这一层不管，由调用方决定要不要当成错误。 */
export function readEnumArray<T extends string>(
	source: ConfigSource,
	path: ConfigPath,
	allowed: readonly T[],
): readonly T[] | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new ConfigError(`${describePath(path)} must be an array`, locate(source, path));
	}
	const result: T[] = [];
	for (const item of value) {
		const match = allowed.find((candidate) => candidate === item);
		if (match === undefined) {
			throw new ConfigError(`${describePath(path)} elements must be one of ${allowed.join(", ")}`, locate(source, path));
		}
		result.push(match);
	}
	return result;
}

export function readStringArray(source: ConfigSource, path: ConfigPath): readonly string[] | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new ConfigError(`${describePath(path)} must be an array of strings`, locate(source, path));
	}
	for (const item of value) {
		if (typeof item !== "string") {
			throw new ConfigError(`${describePath(path)} elements must all be strings`, locate(source, path));
		}
	}
	return value as readonly string[];
}

export function readStringMap(
	source: ConfigSource,
	path: ConfigPath,
): Readonly<Record<string, string>> | undefined {
	const value = source.get(path);
	if (value === undefined) return undefined;
	if (!isConfigTable(value)) {
		throw new ConfigError(`${describePath(path)} must be a table of strings`, locate(source, path));
	}
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw new ConfigError(`${describePath([...path, key])} must be a string`, locate(source, [...path, key]));
		}
		result[key] = item;
	}
	return result;
}
