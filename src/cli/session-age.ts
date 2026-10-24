/**
 * 会话最近活动时间的人话表示。
 *
 * 面板里时间单独占一列，用完整词组比 `2h` 更容易一眼读懂；只保留最大单位，
 * 「2 hours ago」已经够判断新旧，再精确到分钟反而更长也更吵。
 *
 * 取整一律向下：刚过一小时写成「1 hour ago」而不是四舍五入成「2 hours ago」，
 * 时间只会显得比实际更久，不会让人以为它比实际更新。
 */
export function sessionAge(updatedAt: string, now = Date.now()): string {
	const elapsed = now - Date.parse(updatedAt);
	// 解析失败或时间在未来：宁可不显示，也不给出一个编出来的相对时间
	if (!Number.isFinite(elapsed) || elapsed < 0) return "";

	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return plural(minutes, "minute");

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return plural(hours, "hour");

	const days = Math.floor(hours / 24);
	if (days < 7) return plural(days, "day");

	const weeks = Math.floor(days / 7);
	if (weeks < 52) return plural(weeks, "week");

	return plural(Math.floor(weeks / 52), "year");
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
