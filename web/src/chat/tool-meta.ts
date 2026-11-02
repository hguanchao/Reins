import {
	Bot,
	FilePenLine,
	FileText,
	FolderTree,
	Globe,
	ListTodo,
	Map,
	Plug,
	Search,
	Terminal,
	Wrench,
	type LucideIcon,
} from "lucide-react";

/** 工具行的展示信息；集中一处，新增工具时只补这里。 */
const LABELS: Readonly<Record<string, string>> = {
	read: "读取",
	write: "写入",
	edit: "编辑",
	patch: "补丁",
	bash: "命令",
	pwsh: "PowerShell",
	grep: "搜索",
	find: "查找",
	ls: "目录",
	web_fetch: "网页",
	todo: "任务",
	present_plan: "计划",
	subagent: "子代理",
};

const ICONS: Readonly<Record<string, LucideIcon>> = {
	read: FileText,
	write: FilePenLine,
	edit: FilePenLine,
	patch: FilePenLine,
	bash: Terminal,
	pwsh: Terminal,
	grep: Search,
	find: Search,
	ls: FolderTree,
	web_fetch: Globe,
	todo: ListTodo,
	present_plan: Map,
	subagent: Bot,
};

export function toolLabel(name: string): string {
	return LABELS[name] ?? name;
}

export function toolIcon(name: string): LucideIcon {
	return ICONS[name] ?? (name.startsWith("mcp__") ? Plug : Wrench);
}

/** 一行里最有信息量的参数：命令、路径、模式或网址。 */
export function toolPrimary(name: string, args: Record<string, unknown> | undefined): string | undefined {
	if (args === undefined) return undefined;
	const order = ["command", "path", "pattern", "url", "query"];
	for (const key of order) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	if (name === "todo") {
		const todos = args["todos"];
		if (Array.isArray(todos)) return `${todos.length} 项`;
	}
	return undefined;
}

export interface DiffStats {
	readonly added: number;
	readonly removed: number;
}

export function diffStats(diff: string | undefined): DiffStats {
	let added = 0;
	let removed = 0;
	if (diff !== undefined) {
		for (const line of diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
			else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
		}
	}
	return { added, removed };
}

/** 从工具 details 里找出 unified diff；edit/patch 是两种不同形状。 */
export function diffOf(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details["diff"] === "string") return details["diff"];
	const files = details["files"];
	if (!Array.isArray(files)) return undefined;
	const parts = files
		.map((file) => {
			if (!isRecord(file) || typeof file["diff"] !== "string") return undefined;
			const path = typeof file["path"] === "string" ? file["path"] : "";
			return path.length === 0 ? file["diff"] : `### ${path}\n${file["diff"]}`;
		})
		.filter((part): part is string => part !== undefined);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** 没有 diff 时的详情文本；对象按缩进 JSON 展示，至少不丢信息。 */
export function detailText(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
