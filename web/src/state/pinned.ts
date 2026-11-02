/** 置顶会话：只存在本机，跨会话保留；服务端不需要知道界面上的分组。 */

const STORAGE_KEY = "reins-pinned-sessions";

export function readPinnedSessions(): ReadonlySet<string> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((value): value is string => typeof value === "string"));
	} catch {
		return new Set();
	}
}

export function writePinnedSessions(ids: ReadonlySet<string>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		// 存储不可用时只在本次生效
	}
}
