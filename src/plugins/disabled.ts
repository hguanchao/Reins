/**
 * 插件禁用清单的纯函数。
 *
 * 配置里的 plugins.disabled 是插件标识的数组；启停只改这一份清单，实际装载在服务重启后
 * 由插件宿主读取。去重并排序，避免同一标识重复写入。
 */
export function withPluginDisabled(
	current: readonly string[],
	name: string,
	disabled: boolean,
): readonly string[] {
	const next = new Set(current);
	if (disabled) next.add(name);
	else next.delete(name);
	return [...next].sort();
}
