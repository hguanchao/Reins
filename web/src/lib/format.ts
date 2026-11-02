/** 界面里反复用到的格式化；只放纯函数，便于单测与复用。 */

export function relativeTime(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const delta = Date.now() - time;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (delta < minute) return "刚刚";
	if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
	if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
	if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
	return new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function workspaceName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? cwd;
}

export function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCost(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}
