/** 字节数的可读格式：KB 起保留一位小数，去掉无意义的 `.0`。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const text = value.toFixed(1);
	return `${text.endsWith(".0") ? text.slice(0, -2) : text} ${units[unit]}`;
}

/**
 * 耗时可读格式：界面里所有耗时的唯一格式。
 *
 * 秒起步保留一位小数(0.5s),不满一秒也不写毫秒；满一分钟收敛成 1m、1m1s,再往上
 * 时、天逐级收敛，单位之间不留空格，保证在任何一行里都占最短且宽度可预测。
 */
export function formatDuration(ms: number): string {
	// 负数与非有限值按 0 处理：调用方传来的多是两个时间戳之差，起点晚于终点就是负的
	const tenths = Math.round((Number.isFinite(ms) && ms > 0 ? ms : 0) / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

	const totalSeconds = Math.round(tenths / 10);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;

	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;

	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0 ? `${days}d` : `${days}d${restHours}h`;
}

/**
 * token 数的紧凑缩写,全界面统一(页脚信息行、状态行、子代理统计)。
 *
 * 100 以下保留整数;100 到 999 也进入 K,向下取整到一位小数,例如 999 → 0.9K;
 * 1000 以上四舍五入到一位小数;接近一百万的 K 值会进位成 M,不出现 1000K。
 */
export function formatCompactTokens(tokens: number): string {
	const value = Math.max(0, tokens);
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (value >= 1_000) {
		const thousands = Math.round((value / 1_000) * 10) / 10;
		if (thousands >= 1_000) return `${trimDecimal(thousands / 1_000)}M`;
		return `${trimDecimal(thousands)}K`;
	}
	if (value >= 100) return `${Math.floor(value / 100) / 10}K`;
	return `${Math.round(value)}`;
}

function trimDecimal(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * 取第一行并截到上限，超出补省略号。
 *
 * 会话标题、工具摘要这类「一句话说明」都只需要首行：整段正文可能是多行日志，界面上放不下。
 * 上限按码位而不是 UTF-16 单元计算，中文与 emoji 不会被从中间劈开。
 */
export function firstLine(text: string, limit: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : line;
}
