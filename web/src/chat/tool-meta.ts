import {
	FileText,
	FolderTree,
	GitCompare,
	Pencil,
	Plug,
	Puzzle,
	Search,
	SquareTerminal,
	Wrench,
	type LucideIcon,
} from "lucide-react";

import { toolAction, type ToolAction } from "../transcript/blocks.ts";
import { diffStats } from "../transcript/diff.ts";

/** 摘要动词：正常语气的动词开头，与图标语义一致。 */
const VERBS: Readonly<Record<string, string>> = {
	read: "读取",
	write: "新建",
	edit: "编辑",
	patch: "补丁",
	bash: "运行",
	pwsh: "运行",
	grep: "搜索",
	find: "查找",
	ls: "列目录",
	web_fetch: "请求",
	todo: "整理待办",
	present_plan: "提交计划",
	subagent: "委派",
};

const ICONS: Readonly<Record<ToolAction, LucideIcon>> = {
	read: FileText,
	search: Search,
	list: FolderTree,
	write: Pencil,
	run: SquareTerminal,
	skill: Puzzle,
	mcp: Plug,
	other: Wrench,
};

export function toolIcon(name: string): LucideIcon {
	if (name === "present_plan") return GitCompare;
	return ICONS[toolAction(name)];
}

export function toolVerb(name: string): string {
	return VERBS[name] ?? "调用";
}

/** 一行里最有信息量的参数：命令、路径、模式或网址。 */
export function toolPrimary(name: string, args: Record<string, unknown> | undefined): string | undefined {
	if (args === undefined) return undefined;
	const order = ["command", "path", "file_path", "pattern", "url", "query"];
	for (const key of order) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	const todos = args["todos"];
	if (name === "todo" && Array.isArray(todos)) return `${todos.length} 项`;
	const skill = args["name"] ?? args["skill"];
	if (toolAction(name) === "skill" && typeof skill === "string") return skill;
	return undefined;
}

/** 工具调用的结果摘录：优先 content，其次逐条 detail 拼接。 */
export function toolOutput(content: string | undefined, detail: string): string {
	return content ?? detail;
}

/** 是否为写入类动作：这类要内联 diff，点击只收起/展开。 */
export function isWriteAction(name: string): boolean {
	return toolAction(name) === "write";
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

/** 工具行的增删读数；没有 diff 时退回全零。 */
export function toolDiffStats(details: unknown): { readonly added: number; readonly removed: number } {
	return diffStats(diffOf(details));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
