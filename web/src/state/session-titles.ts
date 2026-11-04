import type { SessionSummary } from "../protocol.ts";

/**
 * 任务重命名的显示名覆盖。
 *
 * 服务端的会话标题从首条提问推导，改名只是界面诉求：这里把覆盖按会话 id 存在本机，
 * 列出会话与页头取标题时叠上去。撤销改名（清空名字）即删掉覆盖，回到服务端标题。
 */

const STORAGE_KEY = "reins-session-titles";

export type TitleOverrides = Readonly<Record<string, string>>;

/** 读全部覆盖；存储不可用或内容坏掉时当没有改过名。 */
export function readSessionTitles(): TitleOverrides {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const entries = Object.entries(parsed as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
		);
		return Object.fromEntries(entries);
	} catch {
		return {};
	}
}

/**
 * 写入一个会话的覆盖并返回新表；空名字表示撤销改名。
 *
 * 存储不可用时返回的表仍在内存里生效，只是重启后丢失——改名不是需要保证落盘的数据。
 */
export function putSessionTitle(current: TitleOverrides, id: string, title: string): TitleOverrides {
	const trimmed = title.trim();
	const next: Record<string, string> = { ...current };
	if (trimmed.length === 0) delete next[id];
	else next[id] = trimmed;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// 存不下就只在本次生效
	}
	return next;
}

/** 覆盖优先于服务端标题；没有任何覆盖时原样返回，省掉一次无谓的映射。 */
export function withSessionTitles(
	sessions: readonly SessionSummary[],
	titles: TitleOverrides,
): readonly SessionSummary[] {
	if (Object.keys(titles).length === 0) return sessions;
	return sessions.map((session) => {
		const title = titles[session.id];
		return title === undefined ? session : { ...session, title };
	});
}
