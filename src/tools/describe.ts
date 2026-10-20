import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import stripAnsi from "strip-ansi";

import { expandHome, toAbsolutePath } from "../workspace/root.ts";
import { commandCore } from "./command-summary.ts";

/**
 * 工具调用的可读摘要。
 *
 * 折叠行只留目标与少量关键信息；完整参数放在 fullDetail 里，双击展开。未知工具（插件、
 * MCP）回退到紧凑 JSON，内置工具各自给出不提 JSON 语法的摘要。
 */

export interface ToolDescription {
	/** 展示用名称：首字母大写；带命名空间的插件/MCP 名称保持原样 */
	readonly name: string;
	/** 单行参数摘要；没有参数时为空串 */
	readonly detail: string;
	/** 展开后显示的完整参数，可含换行；没有更多信息时省略 */
	readonly fullDetail?: string;
	/** 折叠路径的 file:// 链接；终端支持 OSC 8 时会显示为可点击的链接 */
	readonly linkTarget?: string;
	/** 只读探索工具的分组类型；其他工具不参与工具组 */
	readonly group?: ToolGroupKind;
}

export type ToolGroupKind = "read" | "list" | "search";

/** 展开详情的上限，避免一次双击把整段文件内容或超长 JSON 灌进终端。 */
const DETAIL_MAX_LINES = 40;
const DETAIL_MAX_CHARS = 8 * 1024;

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
	const detail = singleLine(describeDetail(tool, args, workspaceRoot));
	const fullDetail = describeFullDetail(tool, args, detail);
	const linkTarget = fileLinkTarget(tool, args, workspaceRoot);
	const description = {
		name: displayToolName(tool),
		detail,
		...(fullDetail === undefined ? {} : { fullDetail }),
		...(linkTarget === undefined ? {} : { linkTarget }),
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

/** 折叠行的目标：文件工具用 basename，搜索工具用短路径，命令用核心命令。 */
function describeDetail(tool: string, args: Record<string, unknown>, workspaceRoot: string | undefined): string {
	switch (tool) {
		case "read":
		case "write":
		case "edit":
			return basenamePath(text(args["path"]) ?? "(missing path)");
		case "bash":
			return commandCore(singleLine(text(args["command"]) ?? "(no command)"), workspaceRoot);
		case "find": {
			const pattern = text(args["pattern"]) ?? "(no pattern)";
			return withModifiers(shortenText(pattern, 48), scopeModifiers(args["path"]));
		}
		case "grep": {
			const pattern = text(args["pattern"]) ?? "(no pattern)";
			const modifiers = scopeModifiers(args["path"]);
			const glob = text(args["glob"]);
			if (glob !== undefined) modifiers.push(glob);
			return withModifiers(shortenText(pattern, 48), modifiers);
		}
		case "ls": {
			const path = text(args["path"]);
			return path === undefined || path === "." ? "" : shortenPath(path, 48);
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

/** 展开后的完整参数；返回 undefined 表示这次调用自己不带更多信息。 */
function describeFullDetail(tool: string, args: Record<string, unknown>, detail: string): string | undefined {
	switch (tool) {
		// 这些工具的展开内容来自结果，调用参数不再重复展示
		case "read":
		case "write":
		case "edit":
		case "ls":
		case "find":
		case "grep":
			return undefined;
		case "bash": {
			const full = singleLine(text(args["command"]) ?? "(no command)");
			return full === detail ? undefined : full;
		}
		case "subagent": {
			const task = text(args["task"]) ?? "(no task)";
			return task === detail ? undefined : capDetail(task);
		}
		default: {
			const json = JSON.stringify(args, null, 2);
			if (json === "{}") return undefined;
			return capDetail(json);
		}
	}
}

/** 文件类工具的目标路径转成 OSC 8 可用的 file:// 链接。 */
function fileLinkTarget(
	tool: string,
	args: Record<string, unknown>,
	workspaceRoot: string | undefined,
): string | undefined {
	if (tool !== "read" && tool !== "write" && tool !== "edit" && tool !== "ls") return undefined;
	const path = text(args["path"]);
	if (path === undefined) return undefined;
	// 折叠行里没有可见的目标文本，不挂链接
	if (tool === "ls" && path === ".") return undefined;

	const expanded = expandHome(path);
	// 没有工作根时无法可靠解析相对路径；绝对路径不受影响
	if (!isAbsolute(expanded) && workspaceRoot === undefined) return undefined;
	try {
		return pathToFileURL(toAbsolutePath(expanded, workspaceRoot ?? process.cwd())).href;
	} catch {
		// 无法编码成 URL 时宁可不挂链接，也不能让显示层拿到半截转义序列
		return undefined;
	}
}

/** 路径只留最后一段；完整路径在展开里。 */
function basenamePath(path: string): string {	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts.at(-1) ?? path;
}

/** 受宽度约束的短路径：保留尾部，前面用 `…/` 代替。 */
function shortenPath(path: string, limit: number): string {
	if (Array.from(path).length <= limit) return path;

	const parts = path.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
	if (parts.length <= 1) return shortenText(path, limit);

	let tail = parts.at(-1) ?? "";
	if (Array.from(tail).length + 2 > limit) return `…/${shortenText(tail, Math.max(1, limit - 2))}`;

	for (let index = parts.length - 2; index >= 0; index -= 1) {
		const candidate = `${parts[index]}/${tail}`;
		if (Array.from(candidate).length + 2 > limit) break;
		tail = candidate;
	}
	return `…/${tail}`;
}

/** 从开头截断，保留最有区分度的前缀。 */
function shortenText(value: string, limit: number): string {
	const chars = Array.from(value);
	if (chars.length <= limit) return value;
	return `${chars.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

/** 路径参数进入折叠行时附加的搜索范围。 */
function scopeModifiers(path: unknown): string[] {
	const value = text(path);
	return value === undefined || value === "." ? [] : [`in ${shortenPath(value, 36)}`];
}

function withModifiers(base: string, modifiers: readonly string[]): string {
	return modifiers.length === 0 ? base : `${base}  [${modifiers.join(", ")}]`;
}

/** 展开详情的总上限：先清掉终端控制字符，再收敛行数，最后按字符数兜底。 */
function capDetail(text: string): string {
	const lines = sanitizeDetail(text).split("\n");
	let result =
		lines.length > DETAIL_MAX_LINES
			? [...lines.slice(0, DETAIL_MAX_LINES - 1), `… (${lines.length - DETAIL_MAX_LINES + 1} more lines)`].join(
					"\n",
				)
			: lines.join("\n");

	const chars = Array.from(result);
	if (chars.length > DETAIL_MAX_CHARS) result = `${chars.slice(0, DETAIL_MAX_CHARS - 1).join("")}…`;
	return result;
}

/** 多行内容逐行清理：ANSI 与终端控制字符都不能带进界面。 */
export function sanitizeDetail(text: string): string {
	return text.split("\n").map(singleLine).join("\n");
}

/** 摘要只占一行：换行与制表折成空格，转义序列不能带进终端。 */
function singleLine(value: string): string {
	return stripAnsi(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "");
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstLine(text: string, limit: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : line;
}
