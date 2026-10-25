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

/**
 * 读表里的自有键。
 *
 * 配置文件里的键名可以由使用者任意指定，`__proto__`、`constructor` 这类名字会命中原型链。
 * 只认自有属性，既能避免把继承值误当成配置，也能让解析器安全地支持这些键名。
 */
export function tableValue(table: ConfigTable, key: string): ConfigValue | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function hasTableKey(table: ConfigTable, key: string): boolean {
	return Object.hasOwn(table, key);
}

/**
 * 写入表的自有键。
 *
 * 不能直接用 `table[key] = value`：当 key 是 `__proto__` 时，赋值会改掉对象的原型而不是
 * 新增一个键。定义成普通数据属性后，键名只影响表的内容，不影响对象行为。
 */
export function setTableValue(table: ConfigTable, key: string, value: ConfigValue): void {
	Object.defineProperty(table, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}
