import { stringEnum, Type } from "#src/plugins/pi-shim/typebox.ts";

// pi-ai 的 Type 就是 typebox 的再导出，扩展会直接 import 它
export { Type };

/**
 * `@deepseek-ai/pi-ai`（上游为 `@earendil-works/pi-ai`）的工具参数辅助函数。
 *
 * 扩展里最常见的就这一个：把值数组变成字符串枚举 schema。它只是结构，不依赖运行时，
 * 直接复用 typebox 替身的构造即可。
 */
export function StringEnum(values: readonly string[], options?: Record<PropertyKey, unknown>) {
	return stringEnum(values, options);
}
