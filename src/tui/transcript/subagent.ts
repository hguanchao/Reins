import { sanitizeLine } from "#src/tools/describe.ts";
import { formatCompactTokens, formatDuration } from "#src/shared/format.ts";
import { TRANSCRIPT, countSegments, hiddenLines, subagentLabel, subagentMetric } from "#src/tui/copy.ts";
import { displayWidth, sanitizeForDisplay, truncateToWidth } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";
import { swept, type AnimationFrame } from "#src/tui/render/sweep.ts";
import { bandBlankLine, bandedWrappedLines } from "#src/tui/transcript/detail.ts";
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
} from "#src/tui/transcript/style.ts";
import type { LiveSubagentLine, SubagentRunView, TranscriptSubagentGroup } from "#src/tui/transcript/types.ts";

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
				label: truncateToWidth(subagentLabel(index + 1), budget),
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
	const counts = groupCounts(group);
	// 历史回填的组没有起点也没有定格耗时：不能拿 0 当起点现算，否则会显示成
	// 自 1970 年以来的天数。没有耗时数据时只显示计数段。
	const elapsed =
		group.durationMs !== undefined
			? formatDuration(group.durationMs)
			: group.startedAt > 0
				? formatDuration(Math.max(0, Date.now() - group.startedAt))
				: undefined;
	// token 合计只在全部结束时显示:运行中的组还没拿到各成员的用量
	const tokens =
		group.durationMs !== undefined && group.totalTokens !== undefined
			? ` · ⇣${formatCompactTokens(group.totalTokens)}`
			: "";
	// 窄终端上先丢 token、再丢耗时，最后截断标签:整行不能超过内容宽度，否则终端自动折行错位。
	const full = elapsed === undefined ? `  ${counts}` : `  ${counts} (${elapsed}${tokens})`;
	const brief = `  ${counts}`;
	const available = Math.max(0, width - displayWidth(prefix));
	const rest = displayWidth(full) <= available ? full : displayWidth(brief) <= available ? brief : "";
	const label = truncateToWidth(SUBAGENT_GROUP_LABEL, Math.max(0, available - displayWidth(rest)));
	const padding = " ".repeat(Math.max(0, available - displayWidth(label) - displayWidth(rest)));
	return `${prefix}${SUBAGENT_HEAD_COLOR}${label}${RESET}${SUBAGENT_COUNT_COLOR}${rest}${RESET}${padding}`;
}

/** 组内各状态的成员数;文案由文案模块统一拼接,这里只做计数。 */
function groupCounts(group: TranscriptSubagentGroup): string {
	const counts = { running: 0, done: 0, failed: 0 };
	for (const member of group.members) counts[member.status] += 1;
	return countSegments(counts);
}

/** 组清单的一条:四态符号 + 任务摘要 + 右对齐统计段(steps · 耗时);失败行正文位是任务名。 */
function subagentMemberLines(
	member: SubagentRunView & { readonly callId: string },
	width: number,
	position: number,
): readonly string[] {
	const indent = SUBAGENT_ITEM_INDENT;
	const label = subagentLabel(position);
	// 统计段:步数与耗时都进同一括号,段内 · 分隔(通用工具套规则)
	const fullMetric = subagentMetric(member.steps, member.durationMs);
	// 摘要与统计都要挤进一行：行首还有「符号 + 空格 + 标签 + 两个空格」，
	// 这部分必须先扣掉，否则整行会超出内容宽度，终端折行后整屏错位。
	const available = Math.max(0, width - displayWidth(indent) - 2 - displayWidth(label) - 2);
	const metricWidth = displayWidth(fullMetric);
	const summaryBudget = Math.min(SUBAGENT_TASK_WIDTH, Math.max(0, available - metricWidth - 2));
	const summary = truncateToWidth(sanitizeForDisplay(member.task), summaryBudget);
	const metric = displayWidth(summary) + metricWidth + 2 <= available ? fullMetric : "";
	const gap = Math.max(0, available - displayWidth(summary) - displayWidth(metric));

	if (member.status === "running") {
		// 静态占位与动画行同构(运行符 + 标签 + 摘要),重建时整行换扫光与转圈帧
		return [
			`${indent}${SUBAGENT_RUNNING_COLOR}${SUBAGENT_BOLD}◐ ${label}  ${summary}${RESET}`,
		];
	}
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
	const rows = (member.failure ?? TRANSCRIPT.unknownFailure).split("\n");
	const visible = rows.slice(0, DETAIL_BAND_MAX_LINES);
	const hidden = rows.length - visible.length;
	return [
		bandBlankLine(width, bandStart),
		...visible.flatMap((line) =>
			bandedWrappedLines(sanitizeLine(line), width, SUBAGENT_FAILED_COLOR, bandStart, DETAIL_RIGHT_PADDING),
		),
		...(hidden === 0
			? []
			: bandedWrappedLines(hiddenLines(hidden), width, THEME.textSubtle, bandStart, DETAIL_RIGHT_PADDING)),
		bandBlankLine(width, bandStart),
	];
}
