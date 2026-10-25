import type { ToolGroupKind } from "../../tools/describe.ts";
import { formatDuration } from "../../tools/format.ts";
import { resultDetail } from "../../tools/result/detail.ts";
import { resultMetric } from "../../tools/result/metric.ts";
import { COMMAND_GROUP_MIN } from "./style.ts";
import type { TranscriptLine, TranscriptTool, TranscriptTurn } from "./types.ts";

/**
 * 追加一条工具行。
 *
 * 连续两个只读探索工具才收进组；单个工具、写操作、失败行和普通正文都会断开组。运行时
 * 传入 expanded=true 先展开，回合结束时由调用方统一收起。
 *
 * 命令（group==="command"）是延迟分组：运行期一律独立成行，失败回挂与结果挂载都依赖这一
 * 点；只有回合结束时连续够数才由 collapseToolGroups 塌成一组，所以这里既不主动入组，也不
 * 让只读工具并进命令行。
 *
 * 返回 true 表示把上一条普通工具行换成了组对象；调用方如果维护了另一份行数组，需要整段
 * 同步一次，不能只追加新增行。
 */
export function appendToolLine(
	lines: TranscriptLine[],
	tool: TranscriptTool,
	expanded: boolean,
): boolean {
	if (!isEagerGroup(tool.group) || tool.isError === true) {
		lines.push(tool);
		return false;
	}

	const last = lines.at(-1);
	if (typeof last === "object" && last !== null && last.kind === "toolGroup") {
		last.members.push(tool);
		return false;
	}
	if (
		typeof last === "object" &&
		last !== null &&
		last.kind === "tool" &&
		isEagerGroup(last.group) &&
		last.isError !== true
	) {
		lines[lines.length - 1] = { kind: "toolGroup", members: [last, tool], expanded };
		return true;
	}
	lines.push(tool);
	return false;
}

/** 运行期即时成组的只读类型；命令是延迟分组，不在此列。 */
function isEagerGroup(group: ToolGroupKind | undefined): boolean {
	return group === "read" || group === "list" || group === "search";
}

/**
 * 回合结束：收起所有工具组，并把连续够数的命令塌成一个命令组。
 *
 * 命令组只在结束时形成——运行期命令各自独立行（见 appendToolLine）。够数才塌：不足
 * COMMAND_GROUP_MIN 条的短序列保持逐行，一眼能看完。失败的命令不进组，留在顶层可见。
 */
export function collapseToolGroups(lines: TranscriptLine[]): void {
	mergeCommandRuns(lines);
	for (const line of lines) {
		if (typeof line === "object" && line !== null && line.kind === "toolGroup") {
			line.expanded = false;
		}
	}
}

/** 把连续 ≥ COMMAND_GROUP_MIN 条成功的命令行替换成一个收起的命令组。 */
function mergeCommandRuns(lines: TranscriptLine[]): void {
	let i = 0;
	while (i < lines.length) {
		const start = i;
		while (i < lines.length && isCollapsibleCommand(lines[i])) i += 1;
		const runLength = i - start;
		// 不可塌的行自己也要往前走一格，否则 runLength 为 0 时会原地不动
		if (runLength < COMMAND_GROUP_MIN) {
			i = start + runLength + 1;
			continue;
		}
		const members = lines.slice(start, i) as TranscriptTool[];
		lines.splice(start, runLength, { kind: "toolGroup", members, expanded: false });
		i = start + 1;
	}
}

/** 一条可塌进命令组的行：命令工具、非失败。 */
function isCollapsibleCommand(line: TranscriptLine | undefined): boolean {
	return (
		typeof line === "object" &&
		line !== null &&
		line.kind === "tool" &&
		line.group === "command" &&
		line.isError !== true
	);
}

/**
 * 把成功结果挂回工具调用行。
 *
 * 实时路径与历史回填共用同一份规则:指标怎么取、详情怎么展开,改判定只改这一处。
 * bash 的折叠指标是耗时,耗时拿不到时(历史回填)退回 resultMetric 的通用口径。
 */
export function attachToolResult(
	tool: TranscriptTool,
	name: string,
	content: string,
	durationMs?: number,
	details?: unknown,
): void {
	tool.result = content;
	const jobId = backgroundJobId(details);
	const metric =
		jobId !== undefined
			? `background ${jobId}`
			: name === "bash" && durationMs !== undefined
				? formatDuration(durationMs)
				: resultMetric(name, details, content);
	if (metric !== undefined) tool.metric = metric;
	const detail = resultDetail(name, content, details, tool.detail);
	if (detail !== undefined) {
		tool.fullDetail = detail.text;
		tool.detailKind = detail.kind;
	}
}

/** bash 的后台结果在 details 里带 jobId；折叠行据此显示作业编号。 */
function backgroundJobId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const value = (details as { readonly jobId?: unknown }).jobId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 把失败结果改写到工具调用行本身。
 *
 * 失败行就是调用行:保留命令与耗时,错误详情留给双击展开。
 */
export function attachToolFailure(
	tool: TranscriptTool,
	errorText: string,
	durationMs?: number,
): void {
	tool.isError = true;
	if (durationMs !== undefined) tool.durationMs = durationMs;
	tool.detailKind = "text";
	const command = tool.fullDetail ?? tool.detail;
	tool.fullDetail = errorText.length > 0 ? `${command}\n\n${errorText}` : command;
}

/** 找到某个工具调用对应的展示行，成功结果据此挂回。 */
export function findToolByCallId(
	lines: readonly TranscriptLine[],
	callId: string,
): TranscriptTool | undefined {
	for (const line of lines) {
		if (typeof line !== "object" || line === null) continue;
		if (line.kind === "tool" && line.callId === callId) return line;
		if (line.kind === "toolGroup") {
			const member = line.members.find((item) => item.callId === callId);
			if (member !== undefined) return member;
		}
	}
	return undefined;
}

/**
 * 找到顶层的工具调用行。
 *
 * 失败结果直接改这一行本身；组成员不参与，否则错误会被收起的组头盖住，仍按独立错误行显示。
 */
export function findTopLevelToolByCallId(
	lines: readonly TranscriptLine[],
	callId: string,
): TranscriptTool | undefined {
	for (const line of lines) {
		if (typeof line !== "object" || line === null) continue;
		if (line.kind === "tool" && line.callId === callId) return line;
	}
	return undefined;
}

/** Ctrl+E：展开或收起最近一个思考区块、工具组、任务卡或子代理组。 */
export function toggleLastExpandable(turns: readonly TranscriptTurn[]): boolean {
	for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
		const response = turns[turnIndex]?.response ?? [];
		for (let index = response.length - 1; index >= 0; index -= 1) {
			const line = response[index];
			if (typeof line !== "object" || line === null) continue;
			if (line.kind === "thinkingBlock") {
				line.expanded = !line.expanded;
				return true;
			}
			if (line.kind === "todo") {
				line.collapsed = line.collapsed !== true;
				return true;
			}
			if (line.kind === "subagentGroup") {
				line.expanded = line.expanded !== true;
				return true;
			}
			if (line.kind === "toolGroup" && line.members.length >= 2) {
				line.expanded = !line.expanded;
				return true;
			}
		}
	}
	return false;
}

/** Ctrl+O：展开或收起最近一个成功工具的结果。 */
export function toggleLastToolResult(turns: readonly TranscriptTurn[]): boolean {
	for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
		const response = turns[turnIndex]?.response ?? [];
		for (let index = response.length - 1; index >= 0; index -= 1) {
			const line = response[index];
			if (typeof line !== "object" || line === null) continue;
			if (line.kind === "tool" && line.result !== undefined) {
				line.resultExpanded = !line.resultExpanded;
				return true;
			}
			if (line.kind === "toolGroup") {
				for (let member = line.members.length - 1; member >= 0; member -= 1) {
					const item = line.members[member];
					if (item?.result === undefined) continue;
					// 组收起时结果也被组头盖住：第一次 Ctrl+O 先把组和结果一起打开
					if (!line.expanded) {
						line.expanded = true;
						item.resultExpanded = true;
					} else {
						item.resultExpanded = !item.resultExpanded;
					}
					return true;
				}
			}
		}
	}
	return false;
}

/** 组里是否还有子代理在跑；并行派发时用它决定状态行还要不要继续等待。 */
export function hasRunningSubagent(lines: readonly TranscriptLine[]): boolean {
	for (const line of lines) {
		if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
		if (line.members.some((member) => member.status === "running")) return true;
	}
	return false;
}

/** 这次进度更新是否来自子代理；子代理的进度不该把状态改写回「运行工具」。 */
export function isSubagentCall(lines: readonly TranscriptLine[], callId: string): boolean {
	for (const line of lines) {
		if (typeof line !== "object" || line === null || line.kind !== "subagentGroup") continue;
		if (line.members.some((member) => member.callId === callId)) return true;
	}
	return false;
}
