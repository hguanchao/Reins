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
