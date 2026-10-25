import { readFooterRange } from "../builtin/read.ts";
import { sanitizeDetail, toolPresentation } from "../describe.ts";
import { numberField, record, stringField } from "./fields.ts";
import { hasSpillFooter, stripSpillFooter } from "../spill.ts";

export type ResultDetailKind = "text" | "file" | "diff";

export interface ResultDetail {
	readonly text: string;
	readonly kind: ResultDetailKind;
}

/** 文件预览：超过这个行数时只显示开头与结尾，中间用省略号。 */
const FILE_PREVIEW_FIRST = 5;
const FILE_PREVIEW_LAST = 3;

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
	fileName?: string,
): ResultDetail | undefined {
	if (toolPresentation(tool)?.resultIsDetail !== true) return undefined;
	if (content === undefined || content.length === 0) return undefined;

	switch (tool) {
		case "read":
			return readDetail(content, details, fileName);
		case "edit":
			return diffDetail(content, details);
		case "write":
			return writeDetail(content, details);
		default:
			return { text: sanitizeDetail(content), kind: "text" };
	}
}

/** 文件内容带行号展开；范围来自结构化详情，历史回放则从结果尾注里取。 */
function readDetail(
	content: string,
	details: unknown,
	fileName: string | undefined,
): ResultDetail | undefined {
	const info = record(details);
	if (numberField(info, "lines") === 0 || / is empty$/.test(content)) {
		return { text: "(empty)", kind: "text" };
	}

	// 界面优先用 details 里的完整正文；result 被落盘时它只是预览加说明
	const fullText = stringField(info, "text");
	if (fullText === undefined && hasSpillFooter(content)) {
		return { text: sanitizeDetail(content), kind: "text" };
	}

	const range = fullText === undefined ? readFooterRange(content) : undefined;
	const startLine = numberField(info, "startLine") ?? range?.start ?? 1;
	const endLine = numberField(info, "endLine") ?? range?.end;
	const lines = readLines(fullText ?? content, startLine, endLine);
	if (lines.length === 0) return undefined;

	const pretty = reindentJson(lines, stringField(info, "path") ?? fileName);
	const display = pretty ?? lines;
	// 重排后的行号是显示行号，不再对应原文件；多行 JSON 与普通文件仍按真实行号
	const firstLine = pretty === undefined ? startLine : 1;
	const width = String(firstLine + display.length - 1).length;
	const formatted = display.map((line, index) => numberedLine(firstLine + index, line, width));
	return {
		text: previewLines(formatted, FILE_PREVIEW_FIRST, FILE_PREVIEW_LAST, width + 2),
		kind: "file",
	};
}

/**
 * 压缩 JSON 重新缩进。
 *
 * 只有整段正文是一行对象或数组时才重排：机器生成的文件展开后无法阅读，这是重排唯一能
 * 帮上忙的场景。多行 JSON 保持原样，行号才能继续对应文件；解析失败（读了一半、带注释）
 * 就放弃，不能为了排版改坏内容。
 */
function reindentJson(
	lines: readonly string[],
	fileName: string | undefined,
): readonly string[] | undefined {
	if (fileName === undefined || !/\.json$/i.test(fileName) || lines.length !== 1) return undefined;
	const trimmed = (lines[0] ?? "").trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const formatted = JSON.stringify(parsed, null, 2);
		return formatted === undefined ? undefined : formatted.split("\n");
	} catch {
		return undefined;
	}
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
	const body = stripSpillFooter(content);
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

interface DiffHunkView {
	readonly lines: { number?: number; text: string }[];
	firstNewLine: number | undefined;
	lastNewLine: number | undefined;
}

/**
 * 给 diff 行加行号，并在相邻 hunk 之间插入省略行。
 *
 * 和整段截断不同，这里保留每个 hunk 的完整内容，只省略两个 hunk 之间没有展示的
 * 未改动行。hunk 头只用来确定起始行号，不进入渲染文本：起点已经由行号列说明，
 * 再把 `@@ line N @@` 铺在正文前方只会挤占阅读空间。
 */
function numberDiff(diff: string): string {
	const hunks: DiffHunkView[] = [];
	const leading: string[] = [];
	const counters = { oldLine: 1, newLine: 1, max: 0 };

	for (const line of diff.split("\n")) {
		const header = /^@@ line (\d+) @@/.exec(line);
		if (header !== null) {
			const at = Number(header[1]);
			hunks.push({ lines: [], firstNewLine: undefined, lastNewLine: undefined });
			counters.oldLine = at;
			counters.newLine = at;
			counters.max = Math.max(counters.max, at);
			continue;
		}

		const hunk = currentHunk(hunks, leading, line, counters);
		if (hunk === undefined) continue;
		numberDiffLine(hunk, line, counters);
	}

	return renderNumberedDiff(hunks, leading, String(counters.max).length);
}

/** 找到这一行所属的 hunk；不属于任何 hunk 的引导行记进 leading 并返回 undefined。 */
function currentHunk(
	hunks: DiffHunkView[],
	leading: string[],
	line: string,
	counters: { oldLine: number; newLine: number; max: number },
): DiffHunkView | undefined {
	if (hunks.length > 0 && line.length > 0) return hunks.at(-1);
	// 历史结果可能只有 diff 行没有 @@ 头；按第 1 行起补一个隐式 hunk
	if (line.startsWith("-") || line.startsWith("+") || line.startsWith("  ")) {
		const implicit: DiffHunkView = { lines: [], firstNewLine: undefined, lastNewLine: undefined };
		hunks.push(implicit);
		counters.oldLine = 1;
		counters.newLine = 1;
		return implicit;
	}
	leading.push(line);
	return undefined;
}

/** 按 +/-/上下文 三种前缀给一行编号并推进对应侧的行计数。 */
function numberDiffLine(
	hunk: DiffHunkView,
	line: string,
	counters: { oldLine: number; newLine: number; max: number },
): void {
	if (line.length === 0) return;
	if (line.startsWith("-")) {
		hunk.lines.push({ number: counters.oldLine, text: line });
		counters.max = Math.max(counters.max, counters.oldLine);
		counters.oldLine += 1;
		return;
	}
	if (line.startsWith("+")) {
		hunk.lines.push({ number: counters.newLine, text: line });
		hunk.firstNewLine ??= counters.newLine;
		hunk.lastNewLine = counters.newLine;
		counters.max = Math.max(counters.max, counters.newLine);
		counters.newLine += 1;
		return;
	}
	if (line.startsWith("  ")) {
		hunk.lines.push({ number: counters.oldLine, text: line });
		hunk.firstNewLine ??= counters.newLine;
		hunk.lastNewLine = counters.newLine;
		counters.max = Math.max(counters.max, counters.oldLine);
		counters.oldLine += 1;
		counters.newLine += 1;
		return;
	}
	hunk.lines.push({ text: line });
}

/** 把编号后的 hunk 渲染成行：hunk 之间插省略行，行号右对齐到同一宽度。 */
function renderNumberedDiff(
	hunks: readonly DiffHunkView[],
	leading: readonly string[],
	width: number,
): string {
	const output: string[] = leading.filter((line) => line.length > 0);

	for (const [index, hunk] of hunks.entries()) {
		if (index > 0) output.push(omittedLabel(hunks[index - 1], hunk, width));
		for (const entry of hunk.lines) {
			output.push(
				entry.number === undefined
					? entry.text
					: `${String(entry.number).padStart(width)} ${entry.text}`,
			);
		}
	}

	return output.join("\n");
}

/** 两个相邻 hunk 之间的省略提示：间距按新文件行号算，间距为 0 时只给一个省略号。 */
function omittedLabel(previous: DiffHunkView, next: DiffHunkView, width: number): string {
	const gap =
		next.firstNewLine !== undefined && previous.lastNewLine !== undefined
			? next.firstNewLine - previous.lastNewLine - 1
			: undefined;
	const label =
		gap !== undefined && gap > 0
			? `… ${gap} unchanged ${gap === 1 ? "line" : "lines"}`
			: "…";
	return `${" ".repeat(width + 1)}${label}`;
}
