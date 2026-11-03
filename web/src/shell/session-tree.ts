import type { SessionSummary } from "../protocol.ts";

/** 侧栏会话列表的可见行；归档行保留同一顺序并带灰化标记。 */
export interface SessionRow {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: string;
	readonly pinned: boolean;
	readonly archived: boolean;
}

export type ArchivedFilter = "hide" | "show" | "only";

export interface SessionListInput {
	readonly sessions: readonly SessionSummary[];
	readonly archived: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	readonly query: string;
	readonly archivedFilter: ArchivedFilter;
}

function toRow(session: SessionSummary, pinned: ReadonlySet<string>, archived: boolean): SessionRow {
	return {
		id: session.id,
		title: session.title ?? "新会话",
		updatedAt: session.updatedAt,
		pinned: pinned.has(session.id),
		archived,
	};
}

function matches(row: SessionRow, query: string): boolean {
	if (query.length === 0) return true;
	return row.title.toLowerCase().includes(query.toLowerCase());
}

/** 置顶行排在前面，其余保持服务端给的更新时间顺序；归档按筛选条件并入。 */
export function buildSessionRows(input: SessionListInput): readonly SessionRow[] {
	const active = input.sessions.map((session) => toRow(session, input.pinned, false));
	const archived = input.archived.map((session) => toRow(session, input.pinned, true));
	const rows =
		input.archivedFilter === "hide"
			? active
			: input.archivedFilter === "only"
				? archived
				: [...active, ...archived];
	const query = input.query.trim();
	return rows.filter((row) => matches(row, query)).sort((left, right) => {
		if (left.pinned === right.pinned) return 0;
		return left.pinned ? -1 : 1;
	});
}

/** 视图选项菜单的归档范围文案。 */
export function archivedFilterLabel(filter: ArchivedFilter): string {
	if (filter === "show") return "显示归档";
	if (filter === "only") return "只看归档";
	return "隐藏归档";
}
