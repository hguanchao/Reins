import type { SessionSummary, WorkspaceSummary } from "../protocol.ts";

/** 侧栏会话列表的可见行。归档会话不在侧栏出现，恢复与删除走设置页的「已归档任务」。 */
export interface SessionRow {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: string;
	readonly pinned: boolean;
	readonly cwd: string;
	readonly workspacePath: string | null | undefined;
}

/** 时间分组：进行中（当前会话）→ 今天 → 昨天 → 更早。 */
export type TimeBucket = "active" | "today" | "yesterday" | "earlier";

export interface SessionListInput {
	readonly sessions: readonly SessionSummary[];
	readonly pinned: ReadonlySet<string>;
	/** 搜索入口暂由标题栏占位；不传表示不筛选，保留能力供以后接入 */
	readonly query?: string;
	/** 当前正在看的会话；不在清单里时由列表补一行 */
	readonly currentId: string;
	/** 当前会话还没有任何内容：它没落在磁盘上，清单里补行反而会让空会话提前露面 */
	readonly currentIsDraft: boolean;
	readonly currentCwd?: string;
	readonly currentWorkspacePath?: string | null;
	/** 当前回合是否在跑：决定「进行中」小节是否出现 */
	readonly running?: boolean;
	readonly now?: number;
}

function toRow(session: SessionSummary, pinned: ReadonlySet<string>): SessionRow {
	return {
		id: session.id,
		title: session.title ?? "新任务",
		updatedAt: session.updatedAt,
		pinned: pinned.has(session.id),
		cwd: session.cwd ?? "",
		workspacePath: session.workspacePath,
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
		title: "新任务",
		updatedAt: new Date().toISOString(),
		pinned: false,
		cwd: input.currentCwd ?? "",
		workspacePath: input.currentWorkspacePath,
	};
	return matches(row, (input.query ?? "").trim()) ? row : undefined;
}

/** 置顶行排在前面，其余保持服务端给的更新时间顺序。 */
export function buildSessionRows(input: SessionListInput): readonly SessionRow[] {
	const rows = input.sessions.map((session) => toRow(session, input.pinned));
	const current = currentSessionRow(input);
	const visible = current === undefined ? rows : [current, ...rows];
	return visible.filter((row) => matches(row, (input.query ?? "").trim())).sort((left, right) => {
		if (left.pinned === right.pinned) return 0;
		return left.pinned ? -1 : 1;
	});
}

/** 今天之内算「今天」，前一天算「昨天」，其余归入更早。 */
export function bucketOf(updatedAt: string, now = Date.now()): TimeBucket {
	const time = Date.parse(updatedAt);
	if (Number.isNaN(time)) return "earlier";
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const today = startOfToday.getTime();
	if (time >= today) return "today";
	if (time >= today - 24 * 60 * 60 * 1000) return "yesterday";
	return "earlier";
}

export const BUCKET_LABELS: Readonly<Record<TimeBucket, string>> = {
	active: "进行中",
	today: "今天",
	yesterday: "昨天",
	earlier: "更早",
};

export interface BucketedRows {
	readonly bucket: TimeBucket;
	readonly rows: readonly SessionRow[];
}

/**
 * 把未绑定项目的任务按「进行中 / 今天 / 昨天 / 更早」切开。
 * 正在跑的当前会话单独进「进行中」——它是唯一需要随时回看的一条。
 */
export function bucketRows(
	rows: readonly SessionRow[],
	input: { readonly currentId: string; readonly running: boolean; readonly now?: number },
): readonly BucketedRows[] {
	const now = input.now ?? Date.now();
	const buckets = new Map<TimeBucket, SessionRow[]>();
	const push = (bucket: TimeBucket, row: SessionRow): void => {
		const list = buckets.get(bucket) ?? [];
		list.push(row);
		buckets.set(bucket, list);
	};
	for (const row of rows) {
		if (input.running && row.id === input.currentId) {
			push("active", row);
			continue;
		}
		push(bucketOf(row.updatedAt, now), row);
	}
	return (["active", "today", "yesterday", "earlier"] as const)
		.map((bucket) => ({ bucket, rows: buckets.get(bucket) ?? [] }))
		.filter((group) => group.rows.length > 0);
}

export interface WorkspaceSessionGroup {
	readonly workspace: WorkspaceSummary;
	readonly rows: readonly SessionRow[];
}

export interface SessionGroups {
	readonly unassigned: readonly SessionRow[];
	readonly workspaces: readonly WorkspaceSessionGroup[];
}

/** 一次切换所有工作区组的展开状态，不改变顶层「任务」区的状态。 */
export function toggleAllWorkspaceGroups(
	groups: readonly WorkspaceSessionGroup[],
	openState: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
	const allOpen = groups.every(({ workspace }) => openState[workspace.path] ?? true);
	const nextOpen = !allOpen;
	return Object.fromEntries(groups.map(({ workspace }) => [workspace.path, nextOpen]));
}

/**
 * 按显式项目归属分组。
 *
 * 侧栏的顶层是「在哪干活」：绑定了项目的会话严格归入其项目下，没绑定项目的留在任务区。
 * 一个会话只会出现在其中一处。
 */
export function buildSessionGroups(
	input: SessionListInput & { readonly workspaces: readonly WorkspaceSummary[] },
): SessionGroups {
	const rows = buildSessionRows(input);
	return {
		unassigned: rows.filter((row) => row.workspacePath === null || row.workspacePath === undefined),
		workspaces: input.workspaces.map((workspace) => ({
			workspace,
			rows: rows.filter((row) => row.workspacePath === workspace.path),
		})),
	};
}
