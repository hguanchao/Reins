import { sanitizeLine } from "../../tools/describe.ts";
import { formatDuration } from "../../shared/format.ts";
import { highlightImageMarkers } from "../image.ts";
import { renderMarkdown } from "../render/markdown.ts";
import {
	characterWidth,
	displayWidth,
	truncateToWidth,
	wrapText,
	wrappedLines,
} from "../render/text.ts";
import { THEME } from "../render/theme.ts";
import { todoCardLines } from "../view/todo-card.ts";
import type { AnimationFrame } from "../render/sweep.ts";
import {
	lineIndexAtRow,
	scrollState,
	scrollableLines,
	scrollbarColumn,
	visibleIndexes,
} from "./scroll.ts";
import { highlightSelection, selectionRange, stripTerminalStyles, visibleTextWidth } from "./selection.ts";
import type { SelectionRegion } from "./selection.ts";
import {
	DETAIL_BAND_LEFT,
	DETAIL_RIGHT_PADDING,
	ERROR_COLOR,
	ERROR_MARKER,
	GUTTER_WIDTH,
	MESSAGE_TEXT_COLOR,
	MIN_DETAIL_CONTENT,
	NOTICE_COLOR,
	PLAN_CARD_HINT,
	PLAN_HINT_COLOR,
	PLAN_MARKER_COLOR,
	PLAN_TITLE_COLOR,
	PROMPT_BG,
	PROMPT_INDENT,
	PROMPT_MAX_LINES,
	PROMPT_PREFIX,
	RESET,
	RESPONSE_INDENT,
	THINKING_ACTIVE_COLOR,
	THINKING_BG,
	THINKING_COLOR,
	THINKING_EXPANDED_PREFIX,
	THINKING_PADDING,
	THINKING_PREFIX,
	THINKING_TAIL_LINES,
} from "./style.ts";
import { animatedSubagentLine, subagentGroupLines } from "./subagent.ts";
import { stripLineControls } from "./detail.ts";
import { hasExpandableDetail, toolGroupLines, toolLines, toolResultLines } from "./tool.ts";
import { PLAIN_LINE_META } from "./types.ts";
import type {
	LineMeta,
	LiveSubagentLine,
	PromptRange,
	TranscriptLine,
	TranscriptMetrics,
	TranscriptPlan,
	TranscriptThinking,
	TranscriptTool,
	TranscriptToolGroup,
	TranscriptTurn,
	TranscriptView,
} from "./types.ts";

export function transcriptMetrics(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	notice?: string,
): TranscriptMetrics {
	return measureTranscriptView(buildTranscriptView(terminalWidth, turns, notice), height);
}

/** 按当前宽度构建一次；调用方可以缓存它，供测量、绘制和命中复用。 */
export function buildTranscriptView(
	terminalWidth: number,
	turns: readonly TranscriptTurn[],
	notice?: string,
): TranscriptView {
	return build(contentWidth(terminalWidth), turns, notice);
}

export function measureTranscriptView(view: TranscriptView, height: number): TranscriptMetrics {
	const lastPromptStart = view.prompts.at(-1)?.start ?? 0;
	const rows = Math.max(0, height);
	return {
		totalLines: view.lines.length,
		scrollLines: scrollableLines(view.lines.length, lastPromptStart, rows),
		lastPromptStart,
	};
}

/**
 * 渲染可视窗口。
 *
 * scrollTop 是从 transcript 顶部滚过的行数。提示块被滚出顶部时，把它和它的 1 行 gap
 * 固定在第一行，正文从当前滚动位置继续往下画。
 */
export function renderTranscript(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	scrollTop: number,
	notice?: string,
): readonly string[] {
	return renderTranscriptView(buildTranscriptView(terminalWidth, turns, notice), height, scrollTop);
}

export function renderTranscriptView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	frame?: AnimationFrame,
	selection?: SelectionRegion,
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];
	if (view.lines.length === 0) return Array.from({ length: rows }, () => "");

	const { top } = scrollState(view, rows, scrollTop);
	const indexes = visibleIndexes(view, rows, top);
	const lineAt = (index: number): string => {
		// 运行中的子代理行按当前帧重建：动画只在可见行上花工夫，视图本身不重建
		if (frame !== undefined) {
			const live = view.liveLines.get(index);
			if (live !== undefined) return animatedSubagentLine(live, frame, view.width);
		}
		return view.lines[index] ?? " ".repeat(view.width);
	};
	const visible = indexes.map((index) => {
		const line = lineAt(index);
		if (selection === undefined) return line;
		const meta = view.lineMeta[index] ?? PLAIN_LINE_META;
		const range = selectionRange(index, selection, visibleTextWidth(line), meta.contentStart);
		return range === undefined ? line : highlightSelection(line, range);
	});

	const gutter = scrollbarColumn(rows, view.lines.length, top);
	return visible.map((line, index) => `${line} ${gutter[index]}`);
}

/**
 * 命中某个屏幕行上的思考标题。
 *
 * row 从 1 开始；只有标题行的第一个屏幕行可命中，正文行不算。
 */
export function thinkingHeaderAtRow(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	scrollTop: number,
	row: number,
	notice?: string,
): TranscriptThinking | undefined {
	return thinkingHeaderInView(buildTranscriptView(terminalWidth, turns, notice), height, scrollTop, row);
}

export function thinkingHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptThinking | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.thinkingHeaders.find((header) => header.start === lineIndex)?.block;
}

/** 命中工具组头；成员行和普通工具行都不算。 */
export function toolGroupHeaderAtRow(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	scrollTop: number,
	row: number,
	notice?: string,
): TranscriptToolGroup | undefined {
	return toolGroupHeaderInView(buildTranscriptView(terminalWidth, turns, notice), height, scrollTop, row);
}

export function toolGroupHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptToolGroup | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.groupHeaders.find((header) => header.start === lineIndex)?.group;
}

/** 命中可展开的工具行；展开后的续行不参与，避免点正文时又收回去。 */
export function toolHeaderAtRow(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	scrollTop: number,
	row: number,
	notice?: string,
): TranscriptTool | undefined {
	return toolHeaderInView(buildTranscriptView(terminalWidth, turns, notice), height, scrollTop, row);
}

export function toolHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptTool | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.toolHeaders.find((header) => header.start === lineIndex)?.tool;
}

/** 命中收尾任务卡的头行；双击在收起与展开之间切换。 */
export function todoHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptView["todoHeaders"][number]["card"] | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.todoHeaders.find((header) => header.start === lineIndex)?.card;
}

/** 命中计划卡；双击打开完整计划。 */
export function planHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptPlan | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.planHeaders.find((header) => header.start === lineIndex)?.plan;
}

/** 命中子代理组头；双击在收起与展开之间切换。 */
export function subagentGroupHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptView["subagentHeaders"][number]["group"] | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.subagentHeaders.find((header) => header.start === lineIndex)?.group;
}

/** 命中失败的子代理清单行；双击展开/收起失败原因。 */
export function subagentFailureRowInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): { readonly group: TranscriptView["subagentHeaders"][number]["group"]; readonly callId: string } | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.subagentFailureRows.find((entry) => entry.start === lineIndex);
}

function contentWidth(terminalWidth: number): number {
	return Math.max(0, Math.max(0, terminalWidth) - GUTTER_WIDTH);
}

/** 对话流里可以连成一块的内容类型：同类连续行紧凑排列，块与块之间留空行。 */
type ResponseBlockKind = "text" | "thinking" | "tools" | "todo" | "plan" | "notice";

function responseBlockKind(line: TranscriptLine): ResponseBlockKind {
	if (typeof line === "string") return "text";
	if (line.kind === "markdown") return "text";
	if (line.kind === "tool") return line.isError === true ? "notice" : "tools";
	if (line.kind === "toolGroup") return "tools";
	if (line.kind === "thinkingBlock") return "thinking";
	if (line.kind === "todo") return "todo";
	if (line.kind === "plan") return "plan";
	// 子代理组与普通工具块同类:它是这一轮调用的过程,不该像警告那样自成一块
	if (line.kind === "subagentGroup") return "tools";
	return "notice";
}

/**
 * 相邻两条内容之间是否需要空行。
 *
 * 连续正文和连续工具调用各自属于同一块，保持紧凑；思考区块与失败、警告各自独立成块，
 * 即使前后同类也要分开，否则流式输出读起来会糊成一片。工具调用的失败原因紧跟在调用行
 * 之后，是同一件事的两半，不能被空行拆开。
 */
function needsBlockGap(previous: TranscriptLine, current: TranscriptLine): boolean {
	if (isToolFailure(previous, current)) return false;
	const previousKind = responseBlockKind(previous);
	const currentKind = responseBlockKind(current);
	if (previousKind !== currentKind) return true;
	// 思考、任务卡、计划卡与失败、警告各自独立成块：即使前后同类也要分开
	return (
		currentKind === "thinking" ||
		currentKind === "todo" ||
		currentKind === "plan" ||
		currentKind === "notice"
	);
}

/** 失败行是否属于上一条工具调用。 */
function isToolFailure(previous: TranscriptLine, current: TranscriptLine): boolean {
	if (typeof current !== "object" || current === null) return false;
	if (current.kind !== "tool" || current.isError !== true) return false;
	return (
		typeof previous === "object" &&
		previous !== null &&
		(previous.kind === "tool" || previous.kind === "toolGroup")
	);
}

function build(width: number, turns: readonly TranscriptTurn[], notice: string | undefined): TranscriptView {
	const lines: string[] = [];
	const prompts: PromptRange[] = [];
	const thinkingHeaders: { start: number; block: TranscriptThinking }[] = [];
	const groupHeaders: { start: number; group: TranscriptToolGroup }[] = [];
	const toolHeaders: { start: number; tool: TranscriptTool }[] = [];
	const liveLines = new Map<number, LiveSubagentLine>();
	const todoHeaders: { start: number; card: TranscriptView["todoHeaders"][number]["card"] }[] = [];
	const planHeaders: { start: number; plan: TranscriptPlan }[] = [];
	const subagentHeaders: { start: number; group: TranscriptView["subagentHeaders"][number]["group"] }[] = [];
	const subagentFailureRows: { start: number; group: TranscriptView["subagentHeaders"][number]["group"]; callId: string }[] = [];
	let previousHadResponse = false;

	if (notice !== undefined && notice.length > 0) {
		lines.push(...noticeLines(notice, width));
		// 警告和第一轮对话之间留一行间距，避免系统消息贴住提示块
		if (turns.length > 0) lines.push(" ".repeat(width));
	}

	for (const turn of turns) {
		// 上一条回复和下一条提示之间留一行默认背景，避免提示块直接贴住回复
		if (previousHadResponse) lines.push(" ".repeat(width));

		const promptLines = promptBlock(turn.prompt, width);
		const start = lines.length;
		lines.push(...promptLines);
		// 吸顶 header 下方固定一行空隙
		lines.push(" ".repeat(width));
		const responseStart = lines.length;
		let previousLine: TranscriptLine | undefined;
		for (const line of turn.response) {
			if (previousLine !== undefined && needsBlockGap(previousLine, line)) {
				lines.push(" ".repeat(width));
			}
			previousLine = line;
			if (typeof line === "string") {
				lines.push(...wrappedLines(line, RESPONSE_INDENT, width, MESSAGE_TEXT_COLOR));
				continue;
			}
			if (line.kind === "markdown") {
				lines.push(...renderMarkdown(line.text, width));
				continue;
			}
			if (line.kind === "thinkingBlock") {
				const blockStart = lines.length;
				lines.push(...thinkingBlockLines(line, width));
				thinkingHeaders.push({ start: blockStart, block: line });
				continue;
			}
			if (line.kind === "tool") {
				const toolStart = lines.length;
				lines.push(...toolLines(line, width));
				// 有命令全文或有结果，就有可展开的东西；两样都没有就不登记命中区
				if (hasExpandableDetail(line)) toolHeaders.push({ start: toolStart, tool: line });
				if (line.resultExpanded && line.result !== undefined) {
					lines.push(...toolResultLines(line, width));
				}
				continue;
			}
			if (line.kind === "toolGroup") {
				const groupStart = lines.length;
				const rendered = toolGroupLines(line, width);
				lines.push(...rendered.lines);
				// 单个成员直接按普通工具行渲染，没有组头可点
				if (line.members.length >= 2) groupHeaders.push({ start: groupStart, group: line });
				for (const member of rendered.memberStarts) {
					if (hasExpandableDetail(member.tool)) {
						toolHeaders.push({ start: groupStart + member.start, tool: member.tool });
					}
				}
				continue;
			}
			if (line.kind === "todo") {
				const cardStart = lines.length;
				todoHeaders.push({ start: cardStart, card: line });
				lines.push(...todoCardLines(line, width));
				continue;
			}
			if (line.kind === "plan") {
				const cardStart = lines.length;
				planHeaders.push({ start: cardStart, plan: line });
				lines.push(planCardLine(line, width));
				continue;
			}
			if (line.kind === "subagentGroup") {
				const groupStart = lines.length;
				subagentHeaders.push({ start: groupStart, group: line });
				const rendered = subagentGroupLines(line, width, liveLines, groupStart);
				lines.push(...rendered.lines);
				// 失败行登记双击命中:展开/收起失败原因。failure.start 已经是绝对行号
				// （subagentGroupLines 内部用传入的 groupStart 算过），不能再加一次偏移。
				for (const failure of rendered.failureRows) {
					subagentFailureRows.push({ start: failure.start, group: line, callId: failure.callId });
				}
				continue;
			}
			// 三种提示各有自己的标记与颜色：问题要显眼，中性说明只求看得见
			const marker = line.kind === "warning" ? "!" : line.kind === "info" ? "·" : ERROR_MARKER;
			const color =
				line.kind === "warning" ? NOTICE_COLOR : line.kind === "info" ? THINKING_COLOR : ERROR_COLOR;
			const text = line.kind === "warning" ? `Warning: ${line.text}` : line.text;
			lines.push(...wrappedLines(text, `${RESPONSE_INDENT}${marker} `, width, color));
		}
		prompts.push({ start, height: promptLines.length, responseStart });
		previousHadResponse = turn.response.length > 0;
	}

	return {
		width,
		lines,
		lineMeta: buildLineMeta(lines),
		prompts,
		thinkingHeaders,
		groupHeaders,
		toolHeaders,
		liveLines,
		todoHeaders,
		planHeaders,
		subagentHeaders,
		subagentFailureRows,
	};
}

/**
 * 从已排好的行里补出选区元数据。
 *
 * 工具详情的色带行带行号与缩进：行号是排版刻度，不算内容；同一逻辑行换行出来的续行在
 * 复制时也不该插换行。普通正文没有这些前缀，保持默认元数据。只认详情色带，避免把普通
 * 正文里的缩进当成行号。
 */
function buildLineMeta(lines: readonly string[]): readonly LineMeta[] {
	const meta: LineMeta[] = [];
	// 当前详情色带的内容起点；遇到非详情行、空行或新的行号时重置
	let contentStart = 0;
	let inDetail = false;
	// diff 色带里带行号的上下文行与文件内容长得一样，靠前一条增删行/ hunk 头确认类型
	let diffBand = false;
	for (const line of lines) {
		const detail = line.includes(THEME.detailBg) || line.includes(THEME.diffInsertBg) || line.includes(THEME.diffDeleteBg);
		if (!detail) {
			meta.push(PLAIN_LINE_META);
			inDetail = false;
			contentStart = 0;
			diffBand = false;
			continue;
		}
		const plain = stripTerminalStyles(line);
		if (plain.trim().length === 0) {
			// 色带上下留白与空行：不是一条可续行的内容
			meta.push(PLAIN_LINE_META);
			inDetail = false;
			contentStart = 0;
			diffBand = false;
			continue;
		}
		const trimmed = plain.trimStart();
		if (trimmed.startsWith("@@") || trimmed.startsWith("… (")) {
			// diff 的 hunk 头与省略行是独立行，不能接在上一条逻辑行后面
			contentStart = plain.length - trimmed.length;
			meta.push({ contentStart, softWrap: false });
			inDetail = false;
			diffBand = trimmed.startsWith("@@");
			continue;
		}
		const diff = /^(\s*\d+ )([-+] |  )/.exec(plain);
		if (diff !== null && (diffBand || line.includes(THEME.diffInsertBg) || line.includes(THEME.diffDeleteBg))) {
			contentStart = (diff[1] ?? "").length + 2;
			meta.push({ contentStart, softWrap: false });
			inDetail = true;
			diffBand = true;
			continue;
		}
		const file = /^(\s*\d+  )/.exec(plain);
		if (file !== null) {
			contentStart = (file[1] ?? "").length;
			meta.push({ contentStart, softWrap: false });
			inDetail = true;
			diffBand = false;
			continue;
		}
		if (inDetail) {
			// 详情色带里没有行号的行是上一条逻辑行的软换行续行
			meta.push({ contentStart, softWrap: true });
			continue;
		}
		meta.push(PLAIN_LINE_META);
	}
	return meta;
}

/**
 * 计划卡：只占一行，完整正文留给审批页。
 *
 * 标题取计划里第一个非空标题行；窄终端先丢掉右侧提示，再截断标题，标记本身始终保留。
 */
function planCardLine(plan: TranscriptPlan, width: number): string {
	const prefix = truncateToWidth(`${RESPONSE_INDENT}◇ Plan`, width);
	const title = planTitle(plan.text);
	const available = Math.max(0, width - displayWidth(prefix) - 2);
	const shownTitle = truncateToWidth(title, available);
	const hintFits =
		displayWidth(prefix) + 2 + displayWidth(shownTitle) + displayWidth(PLAN_CARD_HINT) <= width;

	let used = displayWidth(prefix);
	let line = `${PLAN_MARKER_COLOR}${prefix}${RESET}`;
	if (shownTitle.length > 0) {
		line += `${PLAN_TITLE_COLOR}  ${shownTitle}${RESET}`;
		used += 2 + displayWidth(shownTitle);
	}
	if (hintFits) {
		line += `${PLAN_HINT_COLOR}${PLAN_CARD_HINT}${RESET}`;
		used += displayWidth(PLAN_CARD_HINT);
	}
	return `${line}${" ".repeat(Math.max(0, width - used))}`;
}

/** 计划标题：第一个非空、非代码围栏的行，去掉 Markdown 标题记号。 */
function planTitle(text: string): string {
	for (const row of text.split("\n")) {
		const line = sanitizeLine(row).trim();
		if (line.length === 0 || line.startsWith("```")) continue;
		const heading = line.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, "");
		const chars = Array.from(heading);
		return chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : heading;
	}
	return "";
}

/**
 * 思考区块的屏幕行。
 *
 * 标题带符号、不铺底色；正文上下各留一行色带，左侧与工具详情保持同样的留白。
 * 运行时收起只留最后五行屏幕行，结束后收起只留标题，双击展开时给全文。
 */
function thinkingBlockLines(block: TranscriptThinking, width: number): readonly string[] {
	const body = block.partial.length > 0 ? [...block.body, block.partial] : block.body;
	const wrapped = body.flatMap((text) => thinkingBodyLines(text, width));
	const visible = block.expanded
		? wrapped
		: block.running
			? wrapped.slice(-THINKING_TAIL_LINES)
			: [];
	const header = thinkingHeaderLines(block, width);
	if (visible.length === 0) return header;
	return [...header, thinkingBlankLine(width), ...visible, thinkingBlankLine(width)];
}

/**
 * 思考区块的标题行。
 *
 * 收起时用 ✻；展开后用工具组头同款的 ◈，并提亮可点击的标签。耗时继续用弱化色。
 */
function thinkingHeaderLines(block: TranscriptThinking, width: number): readonly string[] {
	const header = thinkingHeaderText(block);
	if (!block.expanded) {
		return wrappedLines(header, THINKING_PREFIX, width, THINKING_COLOR);
	}

	const prefix = THINKING_EXPANDED_PREFIX;
	const label = header.startsWith("Thought for ") ? "Thought for " : header;
	const prefixWidth = displayWidth(prefix);
	const lines = wrapText(header, Math.max(0, width - prefixWidth));
	let offset = 0;

	return lines.map((line, index) => {
		const lead = index === 0 ? prefix : " ".repeat(prefixWidth);
		const activeWidth = Math.max(0, Math.min(line.length, label.length - offset));
		const active = line.slice(0, activeWidth);
		const rest = line.slice(activeWidth);
		offset += line.length;
		const visible = `${lead}${active}${rest}`;
		const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
		return `${THINKING_ACTIVE_COLOR}${lead}${active}${THINKING_COLOR}${rest}${RESET}${padding}`;
	});
}

/** 运行中的标题按起始时间现算；结束后的标题已经在关闭时定格。 */
function thinkingHeaderText(block: TranscriptThinking): string {
	if (!block.running || block.startedAt === undefined) return block.header;
	const elapsed = Math.max(0, Date.now() - block.startedAt);
	return `Thinking… ${formatDuration(Math.floor(elapsed / 1000) * 1000)}`;
}

/** 思考正文的一行：色带在标题符号右侧留出与工具详情相同的列数，带内留一列内边距。 */
function thinkingBodyLines(text: string, width: number): readonly string[] {
	const start = displayWidth(RESPONSE_INDENT) + DETAIL_BAND_LEFT;
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, width - start);
	// 窄终端上留白不能把正文挤没，宽度不够时让出来
	const insideWidth = innerWidth > MIN_DETAIL_CONTENT ? THINKING_PADDING : 0;
	const inside = " ".repeat(insideWidth);
	const contentWidth = Math.max(1, innerWidth - insideWidth - DETAIL_RIGHT_PADDING);

	// 模型输出可能带 CR：终端执行回车后，补齐空格会从行首重写，整条色带被盖掉
	return wrapText(stripLineControls(text), contentWidth).map((line) => {
		const content = `${inside}${truncateToWidth(line, contentWidth)}`;
		const visible = truncateToWidth(content, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - displayWidth(visible)));
		return `${lead}${THINKING_BG}${THINKING_COLOR}${visible}${padding}${RESET}`;
	});
}

/** 思考正文的上下内边距：整条色带，不写内容。 */
function thinkingBlankLine(width: number): string {
	const start = displayWidth(RESPONSE_INDENT) + DETAIL_BAND_LEFT;
	return `${" ".repeat(start)}${THINKING_BG}${" ".repeat(Math.max(0, width - start))}${RESET}`;
}

/** 提示块上下各留一行背景，正文最多三行，放不下时在第三行末尾补省略号。 */
function promptBlock(prompt: string, width: number): readonly string[] {
	const prefixWidth = Math.min(PROMPT_PREFIX.length, width);
	const lines = wrapPrompt(prompt, Math.max(0, width - prefixWidth), PROMPT_MAX_LINES);
	const content = lines.map((line, index) => {
		const prefix = (index === 0 ? PROMPT_PREFIX : PROMPT_INDENT).slice(0, width);
		const usedPrefixWidth = displayWidth(prefix);
		const text = truncateToWidth(line, Math.max(0, width - usedPrefixWidth));
		const padding = " ".repeat(Math.max(0, width - usedPrefixWidth - displayWidth(text)));
		const styled = highlightImageMarkers(text, THEME.image, MESSAGE_TEXT_COLOR);
		return `${PROMPT_BG}${MESSAGE_TEXT_COLOR}${prefix}${styled}${padding}${RESET}`;
	});
	const empty = `${PROMPT_BG}${" ".repeat(width)}${RESET}`;
	return [empty, ...content, empty];
}

/**
 * 启动警告。
 *
 * 与模型回复共用正文缩进和颜色，第一行多一个 `!` 标记，续行与标记后的文字对齐；宽度不够时
 * 按字符换行，交给对话流统一滚动。
 */
function noticeLines(text: string, width: number): readonly string[] {
	return wrappedLines(text, `${RESPONSE_INDENT}! `, width, NOTICE_COLOR);
}

function wrapPrompt(text: string, limit: number, maxLines: number): readonly string[] {
	const lines = wrapText(text, limit);
	if (lines.length <= maxLines) return lines;

	const visible = lines.slice(0, maxLines);
	const ellipsis = "…";
	let last = Array.from(visible[maxLines - 1] ?? "");
	let used = displayWidth(last.join(""));

	while (last.length > 0 && used + 1 > limit) {
		const removed = last.pop();
		used -= characterWidth(removed ?? "");
	}
	visible[maxLines - 1] = last.join("") + ellipsis;
	return visible;
}
