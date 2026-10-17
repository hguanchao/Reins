import { formatDuration } from "../../tui/widgets/spinner.ts";

/**
 * 会话块里的文字。
 *
 * 工具调用在界面上只显示主参数：路径缩成相对工作目录，命令保留原文，其余工具取前几个键值。
 * 时间与耗时也在这里统一格式化，块渲染只负责摆位置。
 */

/** 工具参数在界面上只显示个大概，完整内容在会话文件里。 */
const ARGS_LIMIT = 60;

export function thoughtLabel(elapsedMs: number): string {
	return `Thought for ${formatDuration(elapsedMs)}`;
}

/** 消息右上角的时间：小时不补零，分补零，12 小时制。 */
export function timestampText(ms: number): string {
	const date = new Date(ms);
	const hour = date.getHours() % 12 || 12;
	const minute = date.getMinutes().toString().padStart(2, "0");
	const suffix = date.getHours() < 12 ? "AM" : "PM";
	return `  ${hour}:${minute} ${suffix}`;
}

/** 工具行显示哪几个参数：按工具类型取主参数，路径缩成相对当前工作目录。 */
export function describeTool(
	name: string,
	args: Record<string, unknown>,
	cwd: string | undefined,
): string {
	const text = toolSummary(name, args, cwd);
	return text.length > ARGS_LIMIT ? `${text.slice(0, ARGS_LIMIT)}…` : text;
}

export function toolSummary(
	name: string,
	args: Record<string, unknown>,
	cwd: string | undefined,
): string {
	switch (name.toLowerCase()) {
		case "read":
		case "write":
		case "edit": {
			const path = displayPath(stringArg(args.path) ?? ".", cwd);
			const offset = numberArg(args.offset);
			const limit = numberArg(args.limit);
			if (offset === undefined && limit === undefined) return path;
			const end = limit === undefined ? "" : `–${(offset ?? 0) + limit}`;
			return `${path} (${offset ?? 0}${end})`;
		}
		case "ls":
		case "list_dir":
			return displayPath(stringArg(args.path) ?? ".", cwd);
		case "find": {
			const pattern = stringArg(args.pattern) ?? "";
			const path = stringArg(args.path);
			return path === undefined ? pattern : `${pattern} in ${displayPath(path, cwd)}`;
		}
		case "grep":
		case "glob": {
			const pattern = stringArg(args.pattern);
			const path = stringArg(args.path) ?? stringArg(args.glob);
			if (pattern !== undefined && path !== undefined) return `"${pattern}" ${displayPath(path, cwd)}`;
			if (pattern !== undefined) return `"${pattern}"`;
			return path === undefined ? "" : displayPath(path, cwd);
		}
		case "bash":
		case "shell":
			return stringArg(args.command) ?? "";
		case "webfetch":
		case "web_fetch":
			return stringArg(args.url) ?? "";
		case "websearch":
		case "web_search":
			return stringArg(args.query) ?? "";
		default: {
			const parts: string[] = [];
			for (const [key, value] of Object.entries(args)) {
				if (parts.length >= 3) break;
				parts.push(`${key}=${inlineValue(value)}`);
			}
			return parts.join(" ");
		}
	}
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inlineValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(inlineValue).join(",");
	if (value === null) return "null";
	return "…";
}

/** 绝对路径缩成工作目录内的相对路径，Windows 反斜杠统一成 `/`。 */
export function displayPath(path: string, cwd: string | undefined): string {
	const normalized = path.replace(/\\/g, "/");
	if (cwd === undefined) return normalized;
	const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalized === root) return ".";
	return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

/** 阶段性输出的最后一行：它是给「还在动」这件事作证的。 */
export function lastOutputLine(update: string | undefined): string | undefined {
	if (update === undefined) return undefined;
	const lines = update.split("\n").filter((line) => line.trim().length > 0);
	return lines.at(-1);
}

/** 回合预览只取第一行非空文本。 */
export function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}
