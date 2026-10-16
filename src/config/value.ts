/**
 * 两个配置文件共用的值模型。
 *
 * TOML 侧不会产生 null（在 TOML 里「没有这个键」就够了），JSON 侧会，所以模型里保留 null。
 * 类型检查不在这里做：那部分集中由 reader.ts 承担，这里只描述形状。
 */
export type ConfigScalar = string | number | boolean | null;

export type ConfigValue = ConfigScalar | ConfigValue[] | ConfigTable;

export interface ConfigTable {
	[key: string]: ConfigValue;
}

/** 键路径。TOML 的段都是字符串，JSON 的数组下标是数字。 */
export type ConfigPath = readonly (string | number)[];

export function isConfigTable(value: ConfigValue): value is ConfigTable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConfigArray(value: ConfigValue): value is ConfigValue[] {
	return Array.isArray(value);
}
