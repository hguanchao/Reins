/** 拼接条件类名；不引入 clsx 这类只为一行服务的依赖。 */
export function cn(...values: readonly (string | false | null | undefined)[]): string {
	return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}
