/** 界面里反复用到的格式化；只放纯函数，便于单测与复用。 */

export function relativeTime(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const delta = Date.now() - time;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (delta < minute) return "现在";
	if (delta < hour) return `${Math.floor(delta / minute)}分钟`;
	if (delta < day) return `${Math.floor(delta / hour)}小时`;
	if (delta < 7 * day) return `${Math.floor(delta / day)}天`;
	return new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 当时刻度「14:12」；审批记录与消息轨的时间读数共用。 */
export function clockTime(at: Date = new Date()): string {
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
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
	const seconds = ms / 1000;
	// 一分钟以内给到 0.1s;再长用「分 + 秒」,累计耗时读起来不再是一长串秒数
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}分${whole % 60}秒`;
}

export function formatCost(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

/** 插件实现形态的内部值不该原样展示给使用者。 */
export function pluginKindLabel(kind: string): string {
	switch (kind) {
		case "dsh":
			return "DSH 兼容";
		case "pi":
			return "Pi 兼容";
		case "declarative":
			return "声明式";
		default:
			return kind;
	}
}

/** 沙箱模式配置值的中文名。 */
export function sandboxLabel(mode: string): string {
	switch (mode) {
		case "off":
			return "关闭";
		case "workspace":
			return "仅工作区";
		case "read-only":
			return "只读";
		default:
			return mode;
	}
}
