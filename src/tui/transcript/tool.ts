import { sanitizeLine } from "#src/tools/describe.ts";
import { TRANSCRIPT, hiddenLines, toolGroupSummary } from "#src/tui/copy.ts";
import { formatDuration } from "#src/shared/format.ts";
import {
	coloredLine,
	displayWidth,
	fitToWidth,
	truncateToWidth,
	wrappedLines,
} from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";
import {
	bandBlankLine,
	bandedWrappedLines,
	detailBand,
	expandTabs,
	stripTrailingBlank,
} from "#src/tui/transcript/detail.ts";
import { isRunningTool } from "#src/tui/transcript/model.ts";
import {
	DETAIL_BAND_LEFT,
	DETAIL_RIGHT_PADDING,
	ERROR_COLOR,
	ERROR_MARKER,
	RESPONSE_INDENT,
	TOOL_EXPANDED_MARKER,
	TOOL_GROUP_COLOR,
	TOOL_GROUP_EXPANDED_MARKER,
	TOOL_GROUP_MEMBER_INDENT,
	TOOL_MARKER,
	TOOL_NAME_COLOR,
	TOOL_RESULT_PREVIEW_LINES,
	RESET,
	UNDERLINE,
} from "#src/tui/transcript/style.ts";
import type { TranscriptTool, TranscriptToolGroup } from "#src/tui/transcript/types.ts";

/**
 * 工具组的屏幕行。
 *
 * 两个以上成员才有组头：运行时展开，回合结束收起；单个成员直接按普通工具行渲染。
 * 同时给出每个成员占用的行区间，供双击命中注册——成员展开后的详情行也要能双击收起。
 */
export function toolGroupLines(
	group: TranscriptToolGroup,
	width: number,
): {
	readonly lines: readonly string[];
	readonly memberSpans: readonly {
		readonly start: number;
		readonly end: number;
		readonly tool: TranscriptTool;
	}[];
} {
	const lines: string[] = [];
	const memberSpans: { start: number; end: number; tool: TranscriptTool }[] = [];

	if (group.members.length < 2) {
		const [tool] = group.members;
		if (tool === undefined) return { lines, memberSpans };
		const start = lines.length;
		lines.push(...toolLines(tool, width));
		if (tool.resultExpanded && tool.result !== undefined) {
			lines.push(...toolResultLines(tool, width));
		}
		memberSpans.push({ start, end: lines.length, tool });
		return { lines, memberSpans };
	}

	const marker = group.expanded ? TOOL_GROUP_EXPANDED_MARKER : TOOL_MARKER;
	const prefix = `${RESPONSE_INDENT}${marker} `;
	const limit = Math.max(0, width - displayWidth(prefix));
	lines.push(coloredLine(`${prefix}${fitToWidth(groupHeaderLabel(group.members), limit)}`, width, TOOL_GROUP_COLOR));

	if (group.expanded) {
		for (const member of group.members) {
			const start = lines.length;
			lines.push(...toolLines(member, width, TOOL_GROUP_MEMBER_INDENT));
			if (member.resultExpanded && member.result !== undefined) {
				lines.push(...toolResultLines(member, width, TOOL_GROUP_MEMBER_INDENT));
			}
			memberSpans.push({ start, end: lines.length, tool: member });
		}
	}
	return { lines, memberSpans };
}

/**
 * 成功工具的结果。
 *
 * 与展开的命令全文用同一条色带：两者都是「这一行摊开后的内容」，样式不同会让人以为
 * 其中一种没有展开。结果同样是终端文本——Windows 命令带回车，其他工具可能带转义序列，
 * 先清洗再上屏。
 */
export function toolResultLines(
	tool: TranscriptTool,
	width: number,
	baseIndent = RESPONSE_INDENT,
): readonly string[] {
	const raw = tool.result ?? "";
	const rows = stripTrailingBlank((raw.length === 0 ? TRANSCRIPT.noOutput : raw).split("\n"));
	const visible = rows.slice(0, TOOL_RESULT_PREVIEW_LINES).map(expandTabs);
	const hidden = rows.length - visible.length;
	const bandStart = displayWidth(baseIndent) + DETAIL_BAND_LEFT;

	return [
		bandBlankLine(width, bandStart),
		...visible.flatMap((line) =>
			bandedWrappedLines(sanitizeLine(line), width, THEME.textSecondary, bandStart, DETAIL_RIGHT_PADDING),
		),
		...(hidden === 0
			? []
			: bandedWrappedLines(
					hiddenLines(hidden, "Ctrl+G"),
					width,
					THEME.textSubtle,
					bandStart,
					DETAIL_RIGHT_PADDING,
				)),
		bandBlankLine(width, bandStart),
	];
}

/** 组头按固定顺序汇总：Read → Listed → Searched → Ran。 */
function groupHeaderLabel(members: readonly TranscriptTool[]): string {
	let read = 0;
	let list = 0;
	let search = 0;
	let command = 0;
	for (const member of members) {
		if (member.group === "read") read += 1;
		else if (member.group === "list") list += 1;
		else if (member.group === "search") search += 1;
		else if (member.group === "command") command += 1;
	}
	return toolGroupSummary({ read, list, search, command });
}

/**
 * 工具调用行。
 *
 * 折叠时只显示核心命令：开头多余的工作根 `cd` 已经由描述模块剥掉。失败时这一行本身变成
 * 错误行（× + 命令 + 耗时），不再另起一行；双击展开完整命令与详细错误。
 */
export function toolLines(
	tool: TranscriptTool,
	width: number,
	baseIndent = RESPONSE_INDENT,
): readonly string[] {
	// 下划线表示「这一行有东西可点开」。已完成又什么都展不开的行连标记也不给——它长得
	// 像能点，实际什么都不会发生。运行中的行仍留着标记：否则箭头会在结果到达那一刻冒出来
	const interactive = tool.linkTarget !== undefined || hasExpandableDetail(tool);
	const finished = tool.result !== undefined || tool.fullDetail !== undefined || tool.isError;
	const marker = tool.isError ? ERROR_MARKER : !finished || interactive ? TOOL_MARKER : "";
	const prefix = marker.length === 0 ? baseIndent : `${baseIndent}${marker} `;
	const limit = Math.max(0, width - displayWidth(prefix));
	// 结果还没回来的行按起始时间现算：命令可能跑几十秒，等到结束才知道用了多久等于没有反馈
	const metric =
		tool.metric ?? (isRunningTool(tool) && tool.startedAt !== undefined ? liveDuration(tool.startedAt) : undefined);

	if (tool.isError) {
		const duration = tool.durationMs === undefined ? "" : ` (${formatDuration(tool.durationMs)})`;
		// 失败行显示的是这次调用本身，不是错误摘要：摘要留给展开后的详情
		const reason = sanitizeLine(tool.detail).trim();
		const body = reason.length === 0 ? tool.name : `${tool.name}  ${reason}`;
		const failed = wrappedLines(body + duration, prefix, width, ERROR_COLOR);
		if (tool.detailExpanded === true && tool.fullDetail !== undefined) {
			return [...failed, ...detailBand(tool, baseIndent, width)];
		}
		return failed;
	}

	if (tool.fullDetail !== undefined && tool.detailExpanded === true) {
		return [expandedToolHead(tool, baseIndent, width), ...detailBand(tool, baseIndent, width)];
	}

	// 只有结果可展时，行首也要换成展开标记：否则内容出来了，行首还写着「折叠着」
	if (tool.resultExpanded === true && tool.fullDetail === undefined) {
		return [expandedToolHead(tool, baseIndent, width)];
	}

	if (tool.detail.length === 0 && metric === undefined) {
		return [coloredLine(`${prefix}${fitToWidth(tool.name, limit)}`, width, TOOL_NAME_COLOR)];
	}

	return [toolSummaryLine(prefix, tool.name, tool.detail, metric, tool.linkTarget, width, interactive)];
}

/**
 * 运行中的耗时。
 *
 * 按 0.1s 步进显示，与子代理组头的跳动同一口径：格式化本身就带 0.1s 精度，整秒截断只
 * 会让它永远停在 1.0s、2.0s。重建节奏由刷新帧控制，前缀缓存把重排限制在最后一个回合。
 */
function liveDuration(startedAt: number): string {
	return formatDuration(Math.max(0, Date.now() - startedAt));
}

/** 一行同时有两种颜色：标记与名称弱化，参数用正文色，结果指标再弱一档；指标放不下时省略。 */
function toolSummaryLine(
	prefix: string,
	name: string,
	detail: string,
	metric: string | undefined,
	linkTarget: string | undefined,
	width: number,
	interactive: boolean,
): string {
	const head = fitToWidth(`${prefix}${name}`, width);
	const headWidth = displayWidth(head);
	const available = Math.max(0, width - headWidth);
	const metricText = metric === undefined || metric.length === 0 ? "" : ` (${metric})`;
	const metricWidth = displayWidth(metricText);
	// 指标不能把参数挤到只剩几个字符；要么留出可读的参数，要么不显示指标
	const metricFits =
		metricWidth <= available && (detail.length === 0 || available - metricWidth >= 8);
	const shownMetric = metricFits ? metricText : "";
	const detailBudget = Math.max(0, available - displayWidth(shownMetric));
	const tail = detail.length === 0 ? "" : fitToWidth(`  ${detail}`, detailBudget);
	const shownTail = linkTarget === undefined ? tail : linkTail(tail, linkTarget);
	const padding = " ".repeat(
		Math.max(0, available - displayWidth(tail) - displayWidth(shownMetric)),
	);
	const metricPart = shownMetric.length === 0 ? "" : `${TOOL_NAME_COLOR}${shownMetric}${RESET}`;
	// 可点开或可展开的参数一律带下划线，用的是与链接同一种实线：终端不给点线兜底，
	// 线型区别在不同终端里根本看不出来，不如只用「有线 / 没线」表达一件事
	const tailPart =
		linkTarget === undefined && interactive && shownTail.length > 2
			? `${shownTail.slice(0, 2)}${TOOL_NAME_COLOR}${UNDERLINE}${shownTail.slice(2)}`
			: `${TOOL_NAME_COLOR}${shownTail}`;
	return `${TOOL_NAME_COLOR}${head}${RESET}${tailPart}${RESET}${metricPart}${padding}`;
}

/** 给参数文本挂上 OSC 8 链接；前导缩进留在链接外，终端只给路径画下划线。 */
function linkTail(tail: string, target: string): string {
	if (tail.length <= 2) return tail;
	return `${tail.slice(0, 2)}${osc8Link(target, tail.slice(2))}`;
}

function osc8Link(target: string, text: string): string {
	return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * 展开后的工具标题。
 *
 * 标记换成实心菱形，工具名用强调色，文件路径用路径色；展开态不再显示结果指标，
 * 指标只在折叠行出现。Bash 的命令用琥珀色实线下划线：折叠态是虚线，展开后变实线，
 * 两者一眼能分出当前是哪种状态。
 */
function expandedToolHead(tool: TranscriptTool, baseIndent: string, width: number): string {
	const prefix = truncateToWidth(`${baseIndent}${TOOL_EXPANDED_MARKER} `, width);
	let used = displayWidth(prefix);

	const name = truncateToWidth(tool.name, Math.max(0, width - used));
	used += displayWidth(name);

	const separator = tool.detail.length === 0 ? "" : "  ";
	const gap = truncateToWidth(separator, Math.max(0, width - used));
	used += displayWidth(gap);

	const detail = truncateToWidth(tool.detail, Math.max(0, width - used));
	const command = tool.name === "Bash";
	// 展开态一律实线下划线 + 参数色：命令用琥珀（它是要重跑的东西），其余用路径色。
	// 与折叠态的点状下划线对应——同一段文字从虚线变实线，就是「已经展开」的信号
	const detailColor = command ? THEME.warning : THEME.path;
	const detailPart = detail.length === 0 ? "" : `${UNDERLINE}${detail}`;
	const padding = " ".repeat(Math.max(0, width - used - displayWidth(detail)));

	return `${THEME.textPrimary}${prefix}${name}${RESET}${gap}${detailColor}${detailPart}${RESET}${padding}`;
}

/**
 * 这一行有没有可展开的东西。
 *
 * 命令全文（折叠时被截短的部分）与工具结果都算。`python script.py` 这类命令本身没有被截短，
 * 但它的输出仍然值得看一眼——不能因为「命令没藏东西」就把结果也一起锁在门外。
 * 空输出不算：展开只会得到一行「(no output)」，那不该让人以为这里有东西。
 */
export function hasExpandableDetail(tool: TranscriptTool): boolean {
	if (tool.fullDetail !== undefined) return true;
	return tool.result !== undefined && tool.result.trim().length > 0;
}
