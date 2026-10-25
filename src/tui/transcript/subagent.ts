import { sanitizeLine } from "../../tools/describe.ts";
import { formatCompactTokens, formatDuration } from "../../tools/format.ts";
import { displayWidth, truncateToWidth } from "../text.ts";
import { THEME } from "../theme.ts";
import { swept, type AnimationFrame } from "../sweep.ts";
import { bandBlankLine, bandedWrappedLines } from "./detail.ts";
import {
	DETAIL_BAND_LEFT,
	DETAIL_BAND_MAX_LINES,
	DETAIL_RIGHT_PADDING,
	RESET,
	RESPONSE_INDENT,
	SUBAGENT_BOLD,
	SUBAGENT_COUNT_COLOR,
	SUBAGENT_FAILED_COLOR,
	SUBAGENT_GROUP_LABEL,
	SUBAGENT_HEAD_COLOR,
	SUBAGENT_ITEM_INDENT,
	SUBAGENT_PENDING_MARKER,
	SUBAGENT_RUNNING_COLOR,
	SUBAGENT_TASK_WIDTH,
	SUBAGENT_TEXT_COLOR,
	TOOL_GROUP_EXPANDED_MARKER,
	TOOL_MARKER,
} from "./style.ts";
import type { LiveSubagentLine, SubagentRunView, TranscriptSubagentGroup } from "./types.ts";

/**
 * 子代理组的屏幕行。
 *
 * 收起只有组头一行:标签 + 按 running→done→failed 顺序的计数段 + 括号耗时。
 * 展开追加剧清单一行一条,符号沿用任务卡片的四态语言;清单纯展示。
 * 运行中的耗时与计数由 layout 的 100ms 帧刷新:组行不进 liveLines,
 * 每次 spinner tick 直接 markTranscriptDirty 让视图重建(每轮只有一个组,重建便宜)。
 */
export function subagentGroupLines(
	group: TranscriptSubagentGroup,
	width: number,
	live: Map<number, LiveSubagentLine>,
	start: number,
): { readonly lines: readonly string[]; readonly failureRows: readonly { readonly start: number; readonly callId: string }[] } {
	const lines: string[] = [subagentGroupHead(group, width)];
	const failureRows: { start: number; callId: string }[] = [];

	if (group.expanded !== true) return { lines, failureRows };
	group.members.forEach((member, index) => {
		const memberStart = start + lines.length;
		lines.push(...subagentMemberLines(member, width, index + 1));
		// 失败行登记双击命中(行首,续行不参与)
		if (member.status === "failed" && member.failure !== undefined) {
			failureRows.push({ start: memberStart, callId: member.callId });
		}
		// 运行中的清单行登记动画原料:渲染期换转圈与扫光
		if (member.status === "running") {
			const budget = Math.max(0, width - displayWidth(SUBAGENT_ITEM_INDENT) - 2);
			live.set(memberStart, {
				indent: SUBAGENT_ITEM_INDENT,
				label: truncateToWidth(`Subagent${index + 1}`, budget),
				summary: truncateToWidth(member.task, Math.min(SUBAGENT_TASK_WIDTH, budget)),
			});
		}
	});
	return { lines, failureRows };
}

/** 子代理清单运行行的动画行:转圈、标签与摘要整体扫光,全行青色加粗。 */
export function animatedSubagentLine(
	live: LiveSubagentLine,
	frame: AnimationFrame,
	width: number,
): string {
	const budget = Math.max(0, width - displayWidth(live.indent) - 2);
	const visible = truncateToWidth(`${frame.spinner} ${live.label}  ${live.summary}`, budget);
	const body = swept(visible, frame.sweepPhase, THEME.accentDim, THEME.accentRgb);
	const padding = " ".repeat(Math.max(0, budget - displayWidth(visible)));
	return `${live.indent}${THEME.accent}${SUBAGENT_BOLD}${body}${padding}`;
}

/** 组头一行:青色标签 + 灰色计数段与括号统计(耗时、⇣token)。计数顺序固定 running→done→failed。 */
function subagentGroupHead(group: TranscriptSubagentGroup, width: number): string {
	const marker = group.expanded === true ? TOOL_GROUP_EXPANDED_MARKER : TOOL_MARKER;
	const prefix = `${RESPONSE_INDENT}${marker} `;
	const counts = countSegments(group);
	const elapsed =
		group.durationMs !== undefined
			? formatDuration(group.durationMs)
			: formatDuration(Math.max(0, Date.now() - group.startedAt));
	// token 合计只在全部结束时显示:运行中的组还没拿到各成员的用量
	const tokens =
		group.durationMs !== undefined && group.totalTokens !== undefined
			? ` · ⇣${formatCompactTokens(group.totalTokens)}`
			: "";
	const rest = `  ${counts} (${elapsed}${tokens})`;
	const restWidth = displayWidth(rest);
	const label = truncateToWidth(SUBAGENT_GROUP_LABEL, Math.max(0, width - displayWidth(prefix) - restWidth));
	const padding = " ".repeat(
		Math.max(0, width - displayWidth(prefix) - displayWidth(label) - restWidth),
	);
	return `${prefix}${SUBAGENT_HEAD_COLOR}${label}${RESET}${SUBAGENT_COUNT_COLOR}${rest}${RESET}${padding}`;
}

/** 计数段:全部灰色,只有组头标签是青;没有的段不显示。 */
function countSegments(group: TranscriptSubagentGroup): string {
	const counts = { running: 0, done: 0, failed: 0 };
	for (const member of group.members) counts[member.status] += 1;
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`${counts.running} running`);
	if (counts.done > 0) parts.push(`${counts.done} done`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	return parts.join(" · ");
}

/** 组清单的一条:四态符号 + 任务摘要 + 右对齐统计段(steps · 耗时);失败行正文位是任务名。 */
function subagentMemberLines(
	member: SubagentRunView & { readonly callId: string },
	width: number,
	position: number,
): readonly string[] {
	const indent = SUBAGENT_ITEM_INDENT;
	const label = `Subagent${position}`;
	// 失败行也显示任务名:原因不占清单行,双击展开看
	const summary = truncateToWidth(member.task, SUBAGENT_TASK_WIDTH);

	if (member.status === "running") {
		// 静态占位与动画行同构(运行符 + 标签 + 摘要),重建时整行换扫光与转圈帧
		return [
			`${indent}${SUBAGENT_RUNNING_COLOR}${SUBAGENT_BOLD}◐ ${label}  ${summary}${RESET}`,
		];
	}
	// 统计段:步数与耗时都进同一括号,段内 · 分隔(通用工具套规则)
	const stats: string[] = [];
	if (member.steps !== undefined) stats.push(`${member.steps} steps`);
	if (member.durationMs !== undefined) stats.push(formatDuration(member.durationMs));
	const metric = stats.length === 0 ? "" : ` (${stats.join(" · ")})`;
	const gap = Math.max(
		1,
		width - displayWidth(indent) - 2 - displayWidth(summary) - displayWidth(metric) - 2,
	);
	if (member.status === "failed") {
		// 失败整行失败色:符号、标签、任务名一眼归为一处错误;展开时让位给原因色带
		const failedHead = `${indent}${SUBAGENT_FAILED_COLOR}× ${label}  ${summary}${RESET}`;
		if (member.expanded === true) return [failedHead, ...subagentFailureBand(member, width)];
		return [`${failedHead}${" ".repeat(gap)}${metric}`];
	}
	if (member.status === "done") {
		// 完成圆点也是青色:与标签同一份强调,不落在灰档里
		const head = `${indent}${SUBAGENT_RUNNING_COLOR}● ${RESET}${SUBAGENT_RUNNING_COLOR}${SUBAGENT_BOLD}${label}${RESET}  ${SUBAGENT_TEXT_COLOR}${summary}${RESET}`;
		return [`${head}${" ".repeat(gap)}${metric}`];
	}
	return [`${indent}${SUBAGENT_TEXT_COLOR}${SUBAGENT_PENDING_MARKER} ${SUBAGENT_RUNNING_COLOR}${SUBAGENT_BOLD}${label}${RESET}  ${SUBAGENT_TEXT_COLOR}${summary}${RESET}`];
}

/** 失败原因色带:上下留白的 banded 形态,与工具详情同款;全文都在 member.failure 里。 */
function subagentFailureBand(member: SubagentRunView, width: number): readonly string[] {
	const bandStart = displayWidth(SUBAGENT_ITEM_INDENT) + DETAIL_BAND_LEFT;
	const rows = (member.failure ?? "unknown failure").split("\n");
	const visible = rows.slice(0, DETAIL_BAND_MAX_LINES);
	const hidden = rows.length - visible.length;
	return [
		bandBlankLine(width, bandStart),
		...visible.flatMap((line) =>
			bandedWrappedLines(sanitizeLine(line), width, SUBAGENT_FAILED_COLOR, bandStart, DETAIL_RIGHT_PADDING),
		),
		...(hidden === 0
			? []
			: bandedWrappedLines(`… (${hidden} more lines)`, width, THEME.textSubtle, bandStart, DETAIL_RIGHT_PADDING)),
		bandBlankLine(width, bandStart),
	];
}
