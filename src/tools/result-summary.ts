import { sanitizeDetail } from "./describe.ts";
import { formatBytes } from "./format.ts";

export type ResultDetailKind = "text" | "file" | "diff";

export interface ResultDetail {
	readonly text: string;
	readonly kind: ResultDetailKind;
}

/** 展开态直接用结果的工具：参数不是用户想看的内容，结果才是。 */
const RESULT_DETAIL_TOOLS = new Set(["read", "write", "ls", "find", "grep", "edit"]);
/** 文件预览：超过这个行数时只显示开头与结尾，中间用省略号。 */
const FILE_PREVIEW_FIRST = 5;
const FILE_PREVIEW_LAST = 3;
/** diff 预览：保留更多上下文，但同样省略中间。 */
const DIFF_PREVIEW_FIRST = 20;
const DIFF_PREVIEW_LAST = 10;

/**
 * 工具结束后展开行里显示的内容。
 *
 * 只读查询与编辑的展开态应该回答「实际读到了什么 / 列出了什么 / 改成了什么」，而不是
 * 再把 path、limit 这些调用参数列一遍。其余工具仍由调用摘要负责展开。
 */
export function resultDetail(
	tool: string,
	content: string | undefined,
	details?: unknown,
): ResultDetail | undefined {
	if (!RESULT_DETAIL_TOOLS.has(tool)) return undefined;
	if (content === undefined || content.length === 0) return undefined;

	switch (tool) {
		case "read":
			return readDetail(content, details);
		case "edit":
			return diffDetail(content, details);
		case "write":
			return writeDetail(content, details);
		default:
			return { text: sanitizeDetail(content), kind: "text" };
	}
}

/** 文件内容带行号展开；范围来自结构化详情，历史回放则从结果尾注里取。 */
function readDetail(content: string, details: unknown): ResultDetail | undefined {
	const info = record(details);
	if (numberField(info, "lines") === 0 || / is empty$/.test(content)) {
		return { text: "(empty)", kind: "text" };
	}

	const footer = /\[showing lines (\d+)-(\d+) of (\d+);/.exec(content);
	const startLine = numberField(info, "startLine") ?? (footer === null ? 1 : Number(footer[1]));
	const endLine = numberField(info, "endLine") ?? (footer === null ? undefined : Number(footer[2]));
	const lines = readLines(content, startLine, endLine);
	if (lines.length === 0) return undefined;

	const width = String(startLine + lines.length - 1).length;
	const formatted = lines.map((line, index) => numberedLine(startLine + index, line, width));
	return {
		text: previewLines(formatted, FILE_PREVIEW_FIRST, FILE_PREVIEW_LAST, width + 2),
		kind: "file",
	};
}

function numberedLine(number: number, line: string, width: number): string {
	return `${String(number).padStart(width)}  ${line}`;
}

/** 首尾保留；省略号缩进到内容列，而不是贴在行首。 */
function previewLines(
	lines: readonly string[],
	first: number,
	last: number,
	ellipsisIndent: number,
): string {
	if (lines.length <= first + last) return lines.join("\n");
	return [
		...lines.slice(0, first),
		`${" ".repeat(Math.max(0, ellipsisIndent))}…`,
		...lines.slice(-last),
	].join("\n");
}

function readLines(content: string, startLine: number, endLine: number | undefined): readonly string[] {
	if (endLine !== undefined) {
		const count = endLine - startLine + 1;
		if (count > 0) return content.split("\n").slice(0, count);
	}
	const body = (content.split("\n\n[")[0] ?? content).replace(/\n$/, "");
	return body.length === 0 ? [] : body.split("\n");
}

function diffDetail(content: string, details: unknown): ResultDetail {
	const diff = stringField(record(details), "diff");
	return { text: numberDiff(sanitizeDetail(diff ?? content)), kind: "diff" };
}

function writeDetail(content: string, details: unknown): ResultDetail {
	const diff = stringField(record(details), "diff");
	if (diff === undefined) return { text: sanitizeDetail(content), kind: "text" };
	return { text: numberDiff(sanitizeDetail(diff)), kind: "diff" };
}

/** 给 diff 行加一列行号：删除与上下文用旧行号，新增用新行号。 */
function numberDiff(diff: string): string {
	const entries: { number?: number; text: string }[] = [];
	let oldLine = 1;
	let newLine = 1;
	let max = 0;

	for (const line of diff.split("\n")) {
		const hunk = /^@@ line (\d+) @@/.exec(line);
		if (hunk !== null) {
			oldLine = Number(hunk[1]);
			newLine = oldLine;
			max = Math.max(max, oldLine);
			entries.push({ text: line });
			continue;
		}
		if (line.startsWith("-")) {
			entries.push({ number: oldLine, text: line });
			max = Math.max(max, oldLine);
			oldLine += 1;
			continue;
		}
		if (line.startsWith("+")) {
			entries.push({ number: newLine, text: line });
			max = Math.max(max, newLine);
			newLine += 1;
			continue;
		}
		if (line.startsWith("  ")) {
			entries.push({ number: oldLine, text: line });
			max = Math.max(max, oldLine);
			oldLine += 1;
			newLine += 1;
			continue;
		}
		entries.push({ text: line });
	}

	const width = String(max).length;
	const formatted = entries.map((entry) =>
		entry.number === undefined
			? entry.text
			: `${String(entry.number).padStart(width)} ${entry.text}`,
	);
	return previewLines(formatted, DIFF_PREVIEW_FIRST, DIFF_PREVIEW_LAST, width + 1);
}


/**
 * 工具结果在对话流里的呈现。
 *
 * 折叠行指标优先使用工具返回的结构化 details；历史回放只有结果文本，因此再提供一层保守的
 * 文本回退。展开态对 read/ls/find/grep/edit 直接显示结果内容，避免把 path、limit 这类
 * 调用参数误当成“详情”。
 */
export function resultMetric(tool: string, details: unknown, content: string): string | undefined {
	switch (tool) {
		case "read":
			return readMetric(details, content);
		case "write":
			return writeMetric(details, content);
		case "edit":
			return editMetric(details, content);
		case "grep":
			return countMetric(details, content, "matches", /^No matches for /);
		case "find":
			return countMetric(details, content, "files", /^No files match /);
		case "ls":
			return listMetric(details, content);
		case "subagent":
			return subagentMetric(details);
		default:
			return undefined;
	}
}

function readMetric(details: unknown, content: string): string | undefined {
	const info = record(details);
	if (numberField(info, "lines") === 0) return "empty";

	const total = numberField(info, "totalLines");
	const start = numberField(info, "startLine");
	const end = numberField(info, "endLine");
	if (start !== undefined && end !== undefined) {
		if (total === undefined) return `${start}-${end}`;
		return start === 1 && end === total ? lineLabel(total) : `${start}-${end} of ${total}`;
	}
	return readMetricFromContent(content);
}

function readMetricFromContent(content: string): string | undefined {
	const shown = /\[showing lines (\d+)-(\d+) of (\d+);/.exec(content);
	if (shown !== null) return `${shown[1]}-${shown[2]} of ${shown[3]}`;
	if (/ is empty$/.test(content)) return "empty";

	const body = (content.split("\n\n[")[0] ?? "").replace(/\n$/, "");
	if (body.length === 0) return undefined;
	return lineLabel(body.split("\n").length);
}

function lineLabel(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`;
}

function writeMetric(details: unknown, content: string): string | undefined {
	const info = record(details);
	const bytes = numberField(info, "bytes");
	const created = booleanField(info, "created");
	if (bytes !== undefined && created !== undefined) {
		return `${created ? "created" : "overwrote"}, ${formatBytes(bytes)}`;
	}

	const match = /^(Created|Overwrote) .* with (\d+) bytes/.exec(content);
	if (match === null) return undefined;
	const action = match[1] === "Created" ? "created" : "overwrote";
	return `${action}, ${formatBytes(Number(match[2]))}`;
}

function editMetric(details: unknown, content: string): string | undefined {
	const info = record(details);
	if (booleanField(info, "changed") === false) return "unchanged";

	const diff = stringField(info, "diff");
	if (diff !== undefined) {
		const metric = diffStat(diff);
		if (metric !== undefined) return metric;
	}

	const editCount = numberField(info, "editCount");
	if (editCount !== undefined) return `${editCount} ${editCount === 1 ? "edit" : "edits"}`;

	const body = content.includes("\n\n") ? content.slice(content.indexOf("\n\n") + 2) : "";
	const fromContent = diffStat(body);
	if (fromContent !== undefined) return fromContent;
	if (/ is unchanged$/.test(content)) return "unchanged";
	return undefined;
}

function diffStat(diff: string): string | undefined {
	const insertions = (diff.match(/^\+ /gm) ?? []).length;
	const deletions = (diff.match(/^- /gm) ?? []).length;
	if (insertions === 0 && deletions === 0) return undefined;
	return `+${insertions}/-${deletions}`;
}

function countMetric(
	details: unknown,
	content: string,
	noun: "matches" | "files",
	emptyPattern: RegExp,
): string | undefined {
	const matched = numberField(record(details), "matched");
	if (matched !== undefined) {
		if (matched === 0) return `no ${noun}`;
		return countLabel(matched, noun);
	}
	if (emptyPattern.test(content)) return `no ${noun}`;

	const body = content.split("\n\n[")[0] ?? "";
	const count = body.split("\n").filter((line) => line.length > 0).length;
	if (count === 0) return undefined;
	return countLabel(count, noun);
}

function countLabel(count: number, noun: "matches" | "files"): string {
	const one = noun === "matches" ? "match" : "file";
	return `${count} ${count === 1 ? one : noun}`;
}

function listMetric(details: unknown, content: string): string | undefined {
	const total = numberField(record(details), "total");
	if (total !== undefined) return entryLabel(total);
	if (/ is empty$/.test(content)) return "empty";

	const lines = content.split("\n").filter((line) => line.length > 0 && !line.startsWith("… ("));
	return lines.length === 0 ? undefined : entryLabel(lines.length);
}

function entryLabel(count: number): string {
	if (count === 0) return "empty";
	return `${count} ${count === 1 ? "entry" : "entries"}`;
}

function subagentMetric(details: unknown): string | undefined {
	const steps = numberField(record(details), "steps");
	if (steps === undefined) return undefined;
	return `${steps} ${steps === 1 ? "step" : "steps"}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberField(recorded: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = recorded?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(recorded: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = recorded?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function stringField(recorded: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = recorded?.[key];
	return typeof value === "string" ? value : undefined;
}
