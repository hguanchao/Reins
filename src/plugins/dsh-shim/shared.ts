/** dsh 替身与运行时共用的类型守卫。 */
export function isObject(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仅类型引用的 dsh 包在这里放一个空导出，让转发文件有东西可指。 */
export const TYPE_ONLY = Symbol("reins.dsh.type-only");
