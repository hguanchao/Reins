import { Buffer } from "node:buffer";

import stripAnsi from "strip-ansi";

import { commandCore } from "./command-summary.ts";

/**
 * 工具调用的可读摘要。
 *
 * 只把参数变成文字：颜色、缩进和换行由界面决定。未知工具（插件、MCP）回退到紧凑 JSON，
 * 内置工具各自给出不提 JSON 语法的摘要。
 */

export interface ToolDescription {
	/** 展示用名称：首字母大写；带命名空间的插件/MCP 名称保持原样 */
	readonly name: string;
	/** 单行参数摘要；没有参数时为空串 */
	readonly detail: string;
	/** 展开后显示的完整参数；与 detail 相同或没有更多信息时省略 */
	readonly fullDetail?: string;
	/** 只读探索工具的分组类型；其他工具不参与工具组 */
	readonly group?: ToolGroupKind;
}

export type ToolGroupKind = "read" | "list" | "search";

/**
 * 把一次调用转成给人看的文字。
 *
 * workspaceRoot 用来判断命令开头的工作根 `cd` 是否多余：命令本来就在工作根下执行，那条
 * `cd` 是空操作，留着只会把真正要看的部分挤出屏幕。完整命令放在 fullDetail 里，供展开查看。
 */
export function describeToolCall(
	tool: string,
	args: Record<string, unknown>,
	workspaceRoot?: string,
): ToolDescription {
	const group = toolGroupKind(tool);
	const full = singleLine(describeArguments(tool, args));
	const detail = tool === "bash" ? commandCore(full, workspaceRoot) : full;
	const description = {
		name: displayToolName(tool),
		detail,
		...(detail === full ? {} : { fullDetail: full }),
	};
	return group === undefined ? description : { ...description, group };
}

/** 只把连续、只读的探索调用收进工具组；写操作和命令保持独立。 */
export function toolGroupKind(tool: string): ToolGroupKind | undefined {
	switch (tool) {
		case "read":
			return "read";
		case "ls":
			return "list";
		case "find":
		case "grep":
			return "search";
		default:
			return undefined;
	}
}

/** 内置工具里缩写不适合直接展示的，换成完整名称；工具本名仍保持原样。 */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	ls: "List",
};

/** 工具展示名的唯一入口：审批面板、对话流、历史回填与 print-mode 都从这里取名。 */
export function displayToolName(tool: string): string {
	// MCP 的 server__tool 与带命名空间的插件名有自己的写法，不再改写
	if (tool.length === 0 || tool.includes("__") || tool.includes(":")) return tool;
	const renamed = DISPLAY_NAMES[tool];
	if (renamed !== undefined) return renamed;
	const chars = Array.from(tool);
	return `${(chars[0] ?? "").toUpperCase()}${chars.slice(1).join("")}`;
}

function describeArguments(tool: string, args: Record<string, unknown>): string {
	switch (tool) {
		case "read": {
			const path = text(args["path"]) ?? "(missing path)";
			const modifiers: string[] = [];
			const offset = integer(args["offset"]);
			if (offset !== undefined && offset > 1) modifiers.push(`offset ${offset}`);
			const limit = integer(args["limit"]);
			if (limit !== undefined) modifiers.push(`limit ${limit}`);
			return withModifiers(path, modifiers);
		}
		case "write": {
			const path = text(args["path"]) ?? "(missing path)";
			const content = typeof args["content"] === "string" ? args["content"] : undefined;
			return withModifiers(path, content === undefined ? [] : [formatBytes(Buffer.byteLength(content, "utf8"))]);
		}
		case "edit": {
			const path = text(args["path"]) ?? "(missing path)";
			const count = editCount(args["edits"]);
			return withModifiers(
				path,
				count === undefined ? [] : [`${count} edit${count === 1 ? "" : "s"}`],
			);
		}
		case "bash":
			return text(args["command"]) ?? "(no command)";
		case "find": {
			const pattern = text(args["pattern"]) ?? "(no pattern)";
			const modifiers: string[] = [];
			const path = text(args["path"]);
			if (path !== undefined && path !== ".") modifiers.push(`in ${path}`);
			const limit = integer(args["limit"]);
			if (limit !== undefined) modifiers.push(`limit ${limit}`);
			return withModifiers(pattern, modifiers);
		}
		case "grep": {
			const pattern = text(args["pattern"]) ?? "(no pattern)";
			const modifiers: string[] = [];
			const path = text(args["path"]);
			if (path !== undefined && path !== ".") modifiers.push(`in ${path}`);
			const glob = text(args["glob"]);
			if (glob !== undefined) modifiers.push(glob);
			if (args["literal"] === true) modifiers.push("literal");
			if (args["ignoreCase"] === true) modifiers.push("ignore case");
			const limit = integer(args["limit"]);
			if (limit !== undefined) modifiers.push(`limit ${limit}`);
			return withModifiers(pattern, modifiers);
		}
		case "ls": {
			const path = text(args["path"]);
			const modifiers: string[] = [];
			const limit = integer(args["limit"]);
			if (limit !== undefined) modifiers.push(`limit ${limit}`);
			if (path !== undefined && path !== ".") return withModifiers(path, modifiers);
			return modifiers.map((modifier) => `[${modifier}]`).join("  ");
		}
		case "subagent":
			return firstLine(text(args["task"]) ?? "(no task)", 120);
		default: {
			const json = JSON.stringify(args);
			if (json === "{}") return "";
			const chars = Array.from(json);
			return chars.length > 160 ? `${chars.slice(0, 160).join("")}…` : json;
		}
	}
}

/** 摘要只占一行：换行与制表折成空格，转义序列不能带进终端。 */
function singleLine(value: string): string {
	return stripAnsi(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "");
}

function withModifiers(base: string, modifiers: readonly string[]): string {
	return modifiers.length === 0 ? base : `${base}  [${modifiers.join(", ")}]`;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** edit 的参数可能已经是数组，也可能还是 JSON 字符串；两种都数一下。 */
function editCount(value: unknown): number | undefined {
	if (Array.isArray(value)) return value.length;
	if (value !== null && typeof value === "object") return 1;
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.length : 1;
	} catch {
		return 1;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const text = value.toFixed(1);
	return `${text.endsWith(".0") ? text.slice(0, -2) : text} ${units[unit]}`;
}

function firstLine(text: string, limit: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : line;
}
