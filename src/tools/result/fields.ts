/**
 * 工具结构化结果（details）的读取工具。
 *
 * details 来自各工具自己的返回值，历史回放时也可能缺失；这里只做 unknown 到具体形状的
 * 收窄，不做默认值兜底，缺什么就返回 undefined。
 */

export function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function numberField(
	recorded: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = recorded?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanField(
	recorded: Record<string, unknown> | undefined,
	key: string,
): boolean | undefined {
	const value = recorded?.[key];
	return typeof value === "boolean" ? value : undefined;
}

export function stringField(
	recorded: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = recorded?.[key];
	return typeof value === "string" ? value : undefined;
}
