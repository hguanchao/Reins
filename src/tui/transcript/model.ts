import { describeToolCall, type ToolDescription, type ToolGroupKind } from "../../tools/describe.ts";
import { formatDuration } from "../../shared/format.ts";
import { resultDetail } from "../../tools/result/detail.ts";
import { resultMetric } from "../../tools/result/metric.ts";
import type { TranscriptLine, TranscriptTool, TranscriptTurn } from "./types.ts";

/** 把一条工具调用的描述变成对话流行；可选的展开字段缺省时不写入。 */
export function toolLineOf(described: ToolDescription, callId: string): TranscriptTool {
	return {
		kind: "tool",
		name: described.name,
		detail: described.detail,
		...(described.fullDetail === undefined ? {} : { fullDetail: described.fullDetail }),
		...(described.linkTarget === undefined ? {} : { linkTarget: described.linkTarget }),
		group: described.group,
		callId,
	};
}

/** 描述一次工具调用并转成对话流行；实时与历史两条路径共用，形状不会走样。 */
export function describeToolLine(
	name: string,
	args: Record<string, unknown>,
	callId: string,
	workspaceRoot?: string,
): TranscriptTool {
	return toolLineOf(describeToolCall(name, args, workspaceRoot), callId);
}

/**
 * 追加一条工具行。
 *
 * 连续两个可成组的工具就收进组：只读探索调用彼此成组，命令彼此成组，两类不混在一起；
 * 写操作、失败行和普通正文都会断开组。
 *
 * 新组默认收起：组头已经说明在读什么、跑什么，运行期间逐个列出成员只会把整屏刷满。
 * 要看细节双击组头展开。
 *
 * 返回 true 表示把上一条普通工具行换成了组对象；调用方如果维护了另一份行数组，需要整段
 * 同步一次，不能只追加新增行。
 */
export function appendToolLine(
	lines: TranscriptLine[],
	tool: TranscriptTool,
	expanded = false,
): boolean {
	if (!isEagerGroup(tool.group) || tool.isError === true) {
		lines.push(tool);
		return false;
	}

	const last = lines.at(-1);
	if (
		typeof last === "object" &&
		last !== null &&
		last.kind === "toolGroup" &&
		sameGroupFamily(last.members[0]?.group, tool.group)
	) {
		last.members.push(tool);
		return false;
	}
	if (
		typeof last === "object" &&
		last !== null &&
		last.kind === "tool" &&
		isEagerGroup(last.group) &&
		last.isError !== true &&
		sameGroupFamily(last.group, tool.group)
	) {
		lines[lines.length - 1] = { kind: "toolGroup", members: [last, tool], expanded };
		return true;
	}
	lines.push(tool);
	return false;
}

/** 运行期就能成组的类型：只读探索与命令；写操作不进组。 */
function isEagerGroup(group: ToolGroupKind | undefined): boolean {
	return group === "read" || group === "list" || group === "search" || group === "command";
}

/** 命令与只读探索不并进同一组：组头概括的是同一类动作，混在一起折叠后看不出跑了什么。 */
function sameGroupFamily(left: ToolGroupKind | undefined, right: ToolGroupKind | undefined): boolean {
	return (left === "command") === (right === "command");
}

/** 回合结束：收起所有工具组；命令组在运行期就已经形成，这里只负责收起。 */
export function collapseToolGroups(lines: TranscriptLine[]): void {
	for (const line of lines) {
		if (typeof line === "object" && line !== null && line.kind === "toolGroup") {
			line.expanded = false;
		}
	}
}

/**
 * 这条工具调用是否还在跑。
 *
 * 成功结果由 attachToolResult 写入 result，失败由 attachToolFailure 写 isError，两者都没有
 * 就说明结果还没回来。历史回填的行没有起点，一律按已结束处理——那些调用早就结束了。
 */
export function isRunningTool(tool: TranscriptTool): boolean {
	return tool.result === undefined && tool.isError !== true && tool.startedAt !== undefined;
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

/**
 * 失败结果要落到的工具行。
 *
 * 顶层行直接返回；已经在组里的先摘出来，连同失败回到顶层可见——收起的组头不能把错误
 * 盖住。摘走一条后组不够成组，还原成剩下的那条普通工具行。
 */
export function takeToolForFailure(
	lines: TranscriptLine[],
	callId: string,
): TranscriptTool | undefined {
	const top = findTopLevelToolByCallId(lines, callId);
	if (top !== undefined) return top;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (typeof line !== "object" || line === null || line.kind !== "toolGroup") continue;
		const memberIndex = line.members.findIndex((member) => member.callId === callId);
		if (memberIndex < 0) continue;
		const [tool] = line.members.splice(memberIndex, 1);
		if (tool === undefined) return undefined;
		if (line.members.length < 2) {
			const remaining = line.members[0];
			if (remaining === undefined) lines.splice(index, 1);
			else lines.splice(index, 1, remaining);
		}
		// 原位置在前时把错误放在组前，否则放在组后：首尾两条失败仍保持先后顺序
		lines.splice(memberIndex === 0 ? index : index + 1, 0, tool);
		return tool;
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

/** Ctrl+O：展开或收起最近一个成功工具的结果，返回被切换的工具供 Ctrl+G 定位。 */
export function toggleLastToolResult(turns: readonly TranscriptTurn[]): TranscriptTool | undefined {
	for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
		const response = turns[turnIndex]?.response ?? [];
		for (let index = response.length - 1; index >= 0; index -= 1) {
			const line = response[index];
			if (typeof line !== "object" || line === null) continue;
			if (line.kind === "tool" && line.result !== undefined && line.result.trim().length > 0) {
				line.resultExpanded = !line.resultExpanded;
				// 结果色带与完整详情互斥：同时打开会把同一份内容铺两遍
				if (line.resultExpanded) line.detailExpanded = false;
				return line;
			}
			if (line.kind === "toolGroup") {
				for (let member = line.members.length - 1; member >= 0; member -= 1) {
					const item = line.members[member];
					if (item?.result === undefined || item.result.trim().length === 0) continue;
					// 组收起时结果也被组头盖住：第一次 Ctrl+O 先把组和结果一起打开
					if (!line.expanded) {
						line.expanded = true;
						item.resultExpanded = true;
					} else {
						item.resultExpanded = !item.resultExpanded;
					}
					if (item.resultExpanded) item.detailExpanded = false;
					return item;
				}
			}
		}
	}
	return undefined;
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
