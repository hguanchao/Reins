import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { firstLine } from "#src/shared/format.ts";
import { expandHome, toAbsolutePath } from "#src/workspace/root.ts";
import { commandCore } from "#src/tools/command-summary.ts";

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

export type ToolGroupKind = "read" | "list" | "search" | "command";

/**
 * 内置工具的呈现元数据:一个工具在界面上的所有分发行为都从这张表查。
 *
 * 分组类型、展开态是否直接显示结果,过去散在 describe 与 result-summary 的多个
 * switch/集合里,新增工具要改多处。收成一张表后,新增工具加一行。
 */
interface ToolPresentation {
	/** 可成组工具的分组类型;写操作没有 */
	readonly group?: ToolGroupKind;
	/** 展开态直接显示结果内容,而不是把调用参数再列一遍 */
	readonly resultIsDetail: boolean;
}

const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentation>> = {
	read: { group: "read", resultIsDetail: true },
	write: { resultIsDetail: true },
	edit: { resultIsDetail: true },
	ls: { group: "list", resultIsDetail: true },
	find: { group: "search", resultIsDetail: true },
	grep: { group: "search", resultIsDetail: true },
	bash: { group: "command", resultIsDetail: false },
	pwsh: { group: "command", resultIsDetail: false },
	subagent: { resultIsDetail: false },
};

/** 查一个工具的呈现元数据;未知工具(插件、MCP)返回 undefined。 */
export function toolPresentation(tool: string): ToolPresentation | undefined {
	return TOOL_PRESENTATION[tool];
}

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
	const detail = sanitizeLine(describeDetail(tool, args, workspaceRoot));
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

/**
 * 可成组调用返回其分组类型；命令返回 "command"。
 *
 * 只读探索与命令在运行期就会成组，两类不混在一起。写操作返回 undefined，永不进组。
 */
function toolGroupKind(tool: string): ToolGroupKind | undefined {
	return toolPresentation(tool)?.group;
}

/**
 * 是否属于「执行一条 shell 命令」这一类工具。
 *
 * 审批摘要、链接目标与耗时展示都要按同一套规则对待它们。判定取自呈现表的分组，所以以后
 * 再接一种 shell 只要在表里登记一次，不必在各处补工具名。
 */
export function isCommandTool(tool: string): boolean {
	return toolGroupKind(tool) === "command";
}

/** 内置工具里缩写不适合直接展示的，换成完整名称；工具本名仍保持原样。 */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	ls: "List",
	present_plan: "Present plan",
	pwsh: "PowerShell",
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
	// 命令类工具只看那一条命令，具体是哪种 shell 不影响摘要的取法
	if (isCommandTool(tool)) {
		return commandCore(sanitizeLine(text(args["command"]) ?? "(no command)"), workspaceRoot);
	}
	switch (tool) {
		case "read":
		case "write":
		case "edit":
			return basenamePath(text(args["path"]) ?? "(missing path)");
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
			return shortenPath(path ?? ".", 48);
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
	// 展开内容来自结果的工具,调用参数不再重复展示
	if (toolPresentation(tool)?.resultIsDetail === true) return undefined;
	// 命令类工具的展开就是那条命令本身，折叠态只留了核心命令
	if (isCommandTool(tool)) {
		const full = sanitizeLine(text(args["command"]) ?? "(no command)");
		return full === detail ? undefined : full;
	}
	switch (tool) {
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

/**
 * 工具的目标转成 OSC 8 可用的 file:// 链接。
 *
 * 折叠行的下划线由终端为链接绘制，所以每个工具都得有一个目标才有一致的线：
 * - 文件类工具指向那个文件；
 * - 搜索类工具指向它搜索的目录；
 * - 命令指向它执行时所在的工作根——命令本身没有可打开的东西，点开它跑过的目录
 *   是这里唯一说得通的落点。
 */
function fileLinkTarget(
	tool: string,
	args: Record<string, unknown>,
	workspaceRoot: string | undefined,
): string | undefined {
	if (isCommandTool(tool)) return directoryUrl(".", workspaceRoot);
	// 文件类工具(带 path 参数且指向单个文件)指向那个文件;
	// ls 缺省路径就是工作根本身,折叠行同样显示为 `.`,链接跟着指向工作根
	if (tool === "read" || tool === "write" || tool === "edit" || tool === "ls") {
		const path = text(args["path"]) ?? (tool === "ls" ? "." : undefined);
		return path === undefined ? undefined : resolveUrl(path, workspaceRoot);
	}
	// 搜索类工具指向它搜索的目录
	if (tool === "find" || tool === "grep") return directoryUrl(text(args["path"]) ?? ".", workspaceRoot);
	return undefined;
}

function directoryUrl(path: string, workspaceRoot: string | undefined): string | undefined {
	const href = resolveUrl(path, workspaceRoot);
	// 目录 URL 以斜杠结尾，点击打开的是文件夹而不是它里面的同名文件
	return href === undefined || href.endsWith("/") ? href : `${href}/`;
}

function resolveUrl(path: string, workspaceRoot: string | undefined): string | undefined {
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
	return text.split("\n").map(sanitizeLine).join("\n");
}

/** 摘要只占一行：换行与制表折成空格，转义序列不能带进终端。 */
export function sanitizeLine(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * 审批卡展开后的详情。
 *
 * summary 是卡片上能一眼读完的核心：命令的核心段或改动的规模。preview 是展开后才看的
 * 完整命令、聚焦 diff 或待写入内容；两者都只是展示，不改变审批判定。
 */
export interface ApprovalPresentation {
	readonly summary?: string;
	readonly preview?: string;
	readonly previewLabel?: string;
}

/** 展开详情的行数与字符上限：再多也只是滚动，不必把整份文件塞进一帧。 */
const APPROVAL_PREVIEW_MAX_LINES = 200;
const APPROVAL_PREVIEW_MAX_CHARS = 24 * 1024;

function capPreview(text: string): string {
	const lines = sanitizePreviewBlock(text).split("\n");
	let result =
		lines.length > APPROVAL_PREVIEW_MAX_LINES
			? [
					...lines.slice(0, APPROVAL_PREVIEW_MAX_LINES - 1),
					`… (${lines.length - APPROVAL_PREVIEW_MAX_LINES + 1} more lines)`,
				].join("\n")
			: lines.join("\n");
	const chars = Array.from(result);
	if (chars.length > APPROVAL_PREVIEW_MAX_CHARS) {
		result = `${chars.slice(0, APPROVAL_PREVIEW_MAX_CHARS - 1).join("")}…`;
	}
	return result;
}

/** 多行文本拆行；末尾的换行不算多出来的一行。预览保留换行与缩进。 */
function previewLines(value: string): readonly string[] {
	const text = sanitizePreviewBlock(value);
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** 预览需要保留换行与缩进：控制序列与其余控制字符清掉，制表符展开成四列。 */
function sanitizePreviewBlock(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function editPresentation(
	path: string,
	edits: readonly unknown[],
): ApprovalPresentation | undefined {
	const blocks: string[] = [];
	let added = 0;
	let removed = 0;

	edits.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null) return;
		const oldText = (entry as Record<string, unknown>)["oldText"];
		const newText = (entry as Record<string, unknown>)["newText"];
		const oldLines = typeof oldText === "string" ? previewLines(oldText) : [];
		const newLines = typeof newText === "string" ? previewLines(newText) : [];
		if (oldLines.length === 0 && newLines.length === 0) return;

		removed += oldLines.length;
		added += newLines.length;
		const body = [
			...oldLines.map((line) => `- ${line}`),
			...newLines.map((line) => `+ ${line}`),
		];
		blocks.push(`@@ edit ${index + 1} @@\n${body.join("\n")}`);
	});

	if (blocks.length === 0) return undefined;
	const count = blocks.length;
	return {
		summary: `${path} · ${count} ${count === 1 ? "edit" : "edits"} · +${added} −${removed}`,
		preview: capPreview(blocks.join("\n\n")),
		previewLabel: "Diff",
	};
}

/**
 * 审批请求的展示材料。
 *
 * 命令类工具的卡片摘要取核心命令（长内联脚本只留解释器与参数标记），展开才看完整命令；
 * edit 用参数里的新旧文本生成聚焦 diff，write 展示待写入内容。其余工具摘要保持一行 JSON，
 * 展开给格式化后的参数。这些都只用于展示，原始参数仍由权限判定使用。
 */
export function describeApprovalPresentation(
	tool: string,
	args: Record<string, unknown>,
): ApprovalPresentation | undefined {
	if (isCommandTool(tool)) {
		const command = text(args["command"]);
		if (command === undefined) return undefined;
		const full = sanitizePreviewBlock(command).trimEnd();
		if (full.length === 0) return undefined;
		const core = commandCore(sanitizeLine(full));
		if (core.length === 0 || core === full) return undefined;
		// 摘要可能丢掉了命令链的后半段：末尾的省略号提示还有内容，展开可见完整命令
		const summary = core.endsWith("…") ? core : `${core} …`;
		return { summary, preview: capPreview(full), previewLabel: "Command" };
	}

	if (tool === "edit") {
		const path = text(args["path"]) ?? "(missing path)";
		const edits = Array.isArray(args["edits"]) ? args["edits"] : [];
		return editPresentation(path, edits);
	}

	if (tool === "write") {
		const path = text(args["path"]) ?? "(missing path)";
		const content = typeof args["content"] === "string" ? args["content"] : "";
		const lines = previewLines(content);
		return {
			summary: `${path} · ${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
			preview: capPreview(lines.length === 0 ? "(empty file)" : lines.map((line) => `+ ${line}`).join("\n")),
			previewLabel: "Content",
		};
	}

	const json = JSON.stringify(args, null, 2);
	if (json === "{}") return undefined;
	return {
		summary: shortenText(sanitizeLine(JSON.stringify(args)), 160),
		preview: capPreview(json),
		previewLabel: "Arguments",
	};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

