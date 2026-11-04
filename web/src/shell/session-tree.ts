import type { SessionSummary } from "../protocol.ts";

/** 侧栏会话列表的可见行。归档会话不在侧栏出现，恢复与删除走设置页的「已归档会话」。 */
export interface SessionRow {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: string;
	readonly pinned: boolean;
}

export interface SessionListInput {
	readonly sessions: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	readonly query: string;
	/** 当前正在看的会话；不在清单里时由列表补一行 */
	readonly currentId: string;
	/** 当前会话还没有任何内容：它没落在磁盘上，清单里补行反而会让空会话提前露面 */
	readonly currentIsDraft: boolean;
}

function toRow(session: SessionSummary, pinned: ReadonlySet<string>): SessionRow {
	return {
		id: session.id,
		title: session.title ?? "新会话",
		updatedAt: session.updatedAt,
		pinned: pinned.has(session.id),
	};
}

function matches(row: SessionRow, query: string): boolean {
	if (query.length === 0) return true;
	return row.title.toLowerCase().includes(query.toLowerCase());
}

/**
 * 当前会话不在清单里时补一行，让侧栏始终指得出「正在看的会话」。
 * 草稿除外：它还没写入磁盘，发送第一条消息后才会以真实标题出现在工作区列表里。
 */
function currentSessionRow(input: SessionListInput): SessionRow | undefined {
	if (input.currentId.length === 0 || input.currentIsDraft) return undefined;
	const known = input.sessions.some((session) => session.id === input.currentId);
	if (known) return undefined;
	const row: SessionRow = {
		id: input.currentId,
		title: "新会话",
		updatedAt: new Date().toISOString(),
		pinned: false,
	};
	return matches(row, input.query.trim()) ? row : undefined;
}

/** 置顶行排在前面，其余保持服务端给的更新时间顺序。 */
export function buildSessionRows(input: SessionListInput): readonly SessionRow[] {
	const rows = input.sessions.map((session) => toRow(session, input.pinned));
	const current = currentSessionRow(input);
	const visible = current === undefined ? rows : [current, ...rows];
	return visible.filter((row) => matches(row, input.query.trim())).sort((left, right) => {
		if (left.pinned === right.pinned) return 0;
		return left.pinned ? -1 : 1;
	});
}

/**
 * 侧栏两段分组的可见性。
 *
 * 「任务」装会话、「空间」装工作区文件夹；搜索时两段都展开，避免把命中的会话藏进折叠里
 * ——使用者搜到了却看不见，是最难理解的一种「没找到」。
 */
export function sidebarSectionVisibility(
	searching: boolean,
	taskOpen: boolean,
	spaceOpen: boolean,
): { readonly tasks: boolean; readonly spaces: boolean } {
	return {
		tasks: searching || taskOpen,
		spaces: searching || spaceOpen,
	};
}
