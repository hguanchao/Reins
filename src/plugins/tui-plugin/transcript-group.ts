/**
 * 工具汇总组。
 *
 * 连续的可汇总工具（读取、检索、列目录、网页）合成一行，动词用过去式还是进行时由调用方
 * 决定：已经定型的组说「Read 3 files」，正在跑的组说「Reading 3 files」。
 */

export type ToolGroupKind = "file" | "search" | "dir" | "web";

const GROUP_VERBS: Readonly<
	Record<
		ToolGroupKind,
		{ readonly done: string; readonly running: string; readonly one: string; readonly many: string }
	>
> = {
	file: { done: "Read", running: "Reading", one: "file", many: "files" },
	search: { done: "Searched", running: "Searching", one: "pattern", many: "patterns" },
	dir: { done: "Listed", running: "Listing", one: "dir", many: "dirs" },
	web: { done: "Fetched", running: "Fetching", one: "website", many: "websites" },
};

/** 可汇总的工具按动词归类；其余工具（写文件、编辑、执行命令）各自成行。 */
export function groupKindOf(name: string): ToolGroupKind | undefined {
	switch (name.toLowerCase()) {
		case "read":
			return "file";
		case "grep":
		case "find":
		case "glob":
			return "search";
		case "ls":
		case "list_dir":
			return "dir";
		case "webfetch":
		case "web_fetch":
		case "websearch":
		case "web_search":
			return "web";
		default:
			return undefined;
	}
}

export interface GroupedTool {
	readonly name: string;
	readonly isError?: boolean;
}

/** 定型组的标签与失败数。 */
export function groupLabel(members: readonly GroupedTool[]): {
	readonly label: string;
	readonly failed: number;
} {
	const buckets = new Map<ToolGroupKind, number>();
	let failed = 0;
	for (const member of members) {
		const kind = groupKindOf(member.name);
		if (kind === undefined) continue;
		buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
		if (member.isError === true) failed += 1;
	}
	return { label: bucketLabel(buckets, "done"), failed };
}

/** 运行中组的标签，动词用进行时。 */
export function runningGroupLabel(members: readonly GroupedTool[]): string {
	const buckets = new Map<ToolGroupKind, number>();
	for (const member of members) {
		const kind = groupKindOf(member.name);
		if (kind === undefined) continue;
		buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
	}
	return bucketLabel(buckets, "running");
}

function bucketLabel(buckets: ReadonlyMap<ToolGroupKind, number>, tense: "done" | "running"): string {
	let label = "";
	for (const [kind, count] of buckets) {
		const verb = GROUP_VERBS[kind];
		if (label.length > 0) label += ", ";
		label += `${verb[tense]} ${count} ${count === 1 ? verb.one : verb.many}`;
	}
	return label;
}
