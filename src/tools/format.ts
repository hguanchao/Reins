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
