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

/** 耗时可读格式：毫秒、秒、分、时、天逐级收敛，避免长任务显示成一大串秒数。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;

	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) return `${trimDecimal(totalSeconds)}s`;

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	if (totalMinutes < 60) {
		return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;

	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

function trimDecimal(value: number): string {
	const text = value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}
