import { sanitizeLine, type ToolGroupKind } from "../tools/describe.ts";
import { formatDuration } from "../tools/format.ts";
import type { ResultDetailKind } from "../tools/result-summary.ts";
import { highlightCode, type SyntaxSegment } from "../tools/syntax.ts";
import { renderMarkdown } from "./markdown.ts";
import { syntaxColor } from "./syntax-style.ts";
import { characterWidth, displayWidth, fitToWidth, truncateToWidth, wrapText } from "./text.ts";
import { THEME } from "./theme.ts";

/**
 * 对话流渲染。
 *
 * 用户提示按 grok-build 的方式作为吸顶区块：发送后落在视口顶部，回复在它下方增长；
 * 回复向上滚出视口时，提示块固定在顶部，提示下方保留一行空隙。旧提示仍留在滚动流里，
 * 往上滚就能看到，不折叠、不汇总。
 *
 * 启动警告不属于任何一轮对话，但同样走对话流：作为顶部的系统消息参与换行与滚动，不使用
 * 主区域启动画面的居中排版。
 */

export interface TranscriptTurn {
	readonly prompt: string;
	readonly response: readonly TranscriptLine[];
}

/** 对话流里的一行：字符串就是正文，对象形式用于需要区别样式或折叠的行。 */
export type TranscriptLine =
	| string
	| TranscriptNote
	| TranscriptThinking
	| TranscriptTool
	| TranscriptToolGroup
	| TranscriptMarkdown;

/**
 * 模型回复里的 Markdown 文本块。
 *
 * 流式增量直接追加到 text；渲染时才排版，因此代码围栏、列表这类跨行结构在流式过程中
 * 也能按当前完整内容正确解析。普通字符串仍然按纯文本渲染，压缩提示、插件输出不受影响。
 */
export interface TranscriptMarkdown {
	readonly kind: "markdown";
	text: string;
}

/** 需要与正文区分开的一行：警告和失败是要看见的事。 */
export interface TranscriptNote {
	readonly text: string;
	readonly kind: "error" | "warning";
}

/**
 * 工具调用行。
 *
 * name 与 detail 已经由工具描述模块转成给人看的文字；渲染只负责排版。detail 是折叠态看到
 * 的核心命令，fullDetail 是完整命令，双击展开时替换它。失败时 detail 是失败原因，整行用
 * 错误色并带上耗时。
 */
export interface TranscriptTool {
	readonly kind: "tool";
	readonly name: string;
	readonly detail: string;
	/** 展开后的详情；可含换行。工具结束后才生成时也允许写入 */
	fullDetail?: string;
	/** 详情类型：文件内容用行号样式，diff 按增删着色 */
	detailKind?: ResultDetailKind;
	/** 折叠路径的 file:// 链接；终端支持 OSC 8 时会显示为可点击的链接 */
	readonly linkTarget?: string;
	/** 是否在对话流里展开完整参数 */
	detailExpanded?: boolean;
	/** 工具结束后的结果指标，显示在折叠行末尾 */
	metric?: string;
	isError?: boolean;
	durationMs?: number;
	/** 工具调用 id，用于把成功结果挂回对应行 */
	readonly callId?: string;
	/** 只读探索工具的分组类型；失败行和写操作没有 */
	readonly group?: ToolGroupKind;
	/** 成功结果全文；展开时显示 */
	result?: string;
	/** 是否在对话流里展开结果 */
	resultExpanded?: boolean;
}

/**
 * 连续只读工具的组合。
 *
 * 运行时展开显示成员，回合结束折叠成一行组头；双击组头切换。成员保留完整工具行，展开时不丢信息。
 */
export interface TranscriptToolGroup {
	readonly kind: "toolGroup";
	readonly members: TranscriptTool[];
	expanded: boolean;
}

/**
 * 思考区块。
 *
 * 正文完整保留在内存里：运行时默认只显示最后五行，结束后默认只显示标题；双击标题切换
 * 全文。区块对象在对话流里是可变的，流式增量直接写进 body/partial。
 */
export interface TranscriptThinking {
	readonly kind: "thinkingBlock";
	header: string;
	readonly body: string[];
	partial: string;
	running: boolean;
	expanded: boolean;
}

/** 用户提示背景，与菜单面板使用同一档浮起表面。 */
const PROMPT_BG = THEME.surface;
/** 用户提示与回复正文统一使用主文字色。 */
const MESSAGE_TEXT_COLOR = THEME.textPrimary;
/** 思考摘要比正文弱一档：它是过程的痕迹，不是要读的内容。 */
const THINKING_COLOR = THEME.textSubtle;
/** 展开后标题标签的提亮色：主文字色 #e6e9ed。 */
const THINKING_ACTIVE_COLOR = THEME.textPrimary;
/** 思考区块的底色：与用户提示块共用浮起表面，和普通正文分开。 */
const THINKING_BG = THEME.surface;
/** 工具名与标记比正文弱一档，参数才是要读的内容。 */
const TOOL_NAME_COLOR = THEME.textSubtle;
/** 工具组头比普通工具名亮一档，作为一组调用的摘要。 */
const TOOL_GROUP_COLOR = THEME.textSecondary;
/** 失败的行用错误色：出事时那行得能从正文里一眼看见。 */
const ERROR_COLOR = THEME.error;
/** 启动警告使用警告色，与普通正文区分开。 */
const NOTICE_COLOR = THEME.warning;
/** 滚动条颜色。 */
const SCROLLBAR_COLOR = THEME.scrollbar;
const SCROLLBAR_TRACK = " ";
const SCROLLBAR_THUMB = "█";
const RESET = THEME.reset;
/**
 * 实线下划线。
 *
 * 只表示一件事：这一行的参数可以点开（链接）或展开。不用点线——SGR 4:4 要靠终端与字体
 * 同时支持，不支持时退化成实线，反而和链接线混成一样；与其这样，不如只用一种线型。
 */
const UNDERLINE = "\x1b[4m";

/** 一段带颜色的文本；着色只到这一段为止，渲染完要回到调用方给的颜色。 */
interface ColoredSegment {
	readonly text: string;
	readonly color: string;
}

/** 用户提示首行符号前留一列，正文因此比模型回复多缩进一列。 */
const PROMPT_PREFIX = " › ";
/** 提示续行与首行正文对齐。 */
const PROMPT_INDENT = "   ";
/** 模型回复的缩进。 */
const RESPONSE_INDENT = "  ";
/** 运行时收起状态下显示的最后几行思考正文。 */
const THINKING_TAIL_LINES = 5;
/** 成功工具结果默认最多展开多少行。 */
const TOOL_RESULT_PREVIEW_LINES = 20;
/**
 * 展开详情最多渲染的行数。
 *
 * 工具结果可能上千行（列一棵含缓存目录的树、读一个大文件），全铺进对话流会把这一轮的其他
 * 内容挤出屏幕。只截显示不截数据：全文仍留在 tool.fullDetail 里。
 */
const DETAIL_BAND_MAX_LINES = 60;
/** 思考标题的标记：单列火花，与工具行的 ›、失败行的 × 区分。 */
const THINKING_MARKER = "✻";
/** 展开后的菱形标记：工具组头和思考块共用。 */
const EXPANDED_DIAMOND = "◈";
/** 思考标题的缩进；正文缩进到与 Think…/Thought… 的首字对齐。 */
const THINKING_PREFIX = `${RESPONSE_INDENT}${THINKING_MARKER} `;
const THINKING_EXPANDED_PREFIX = `${RESPONSE_INDENT}${EXPANDED_DIAMOND} `;
/** 思考正文的左右内边距。 */
const THINKING_PADDING = 1;
/** 工具调用沿用用户提示的标记，两类条目在同一列起头。 */
const TOOL_MARKER = "›";
/** 展开后的工具用实心菱形，和折叠态区分。 */
const TOOL_EXPANDED_MARKER = "◆";
/** 展开的工具组用带心菱形；收起时沿用工具行的 ›。 */
const TOOL_GROUP_EXPANDED_MARKER = EXPANDED_DIAMOND;
/** 工具组成员比组头多缩进两格。 */
const TOOL_GROUP_MEMBER_INDENT = `${RESPONSE_INDENT}  `;
/** 错误行的标记：与工具失败行共用，错误消息因此有一致的起头。 */
const ERROR_MARKER = "×";
const PROMPT_MAX_LINES = 3;
const HEADER_GAP_LINES = 1;
/** 右侧固定预留一列空隙和一列滚动条。 */
const GUTTER_WIDTH = 2;
/** 展开详情右侧留出的内边距：正文不贴着色带右缘。 */
const DETAIL_RIGHT_PADDING = 1;
/** 详情色带相对标题标记列的左侧留白：色带不贴菱形，行号也不与标题文字挤在同一侧。 */
const DETAIL_BAND_LEFT = 2;
/** 窄终端下正文至少保留的列数：行号与标记必须为它让位，否则这一行什么也读不到。 */
const MIN_DETAIL_CONTENT = 4;

export interface PromptRange {
	/** 提示块第一行在 transcript 里的下标 */
	readonly start: number;
	/** 提示块正文行数，1 到 3 */
	readonly height: number;
	/** 提示块之后的 gap 与回复内容的起点 */
	readonly responseStart: number;
}

/** 构建好的对话流：同一帧的测量、绘制与命中都复用它，避免重复换行整份内容。 */
export interface TranscriptView {
	/** 内容区宽度（已扣掉滚动条列） */
	readonly width: number;
	readonly lines: string[];
	readonly prompts: PromptRange[];
	/** 每个思考区块标题在 lines 里的起点，双击命中使用 */
	readonly thinkingHeaders: readonly { readonly start: number; readonly block: TranscriptThinking }[];
	/** 每个工具组头在 lines 里的起点，双击命中使用 */
	readonly groupHeaders: readonly { readonly start: number; readonly group: TranscriptToolGroup }[];
	/** 每条可展开的工具行在 lines 里的起点，双击命中使用 */
	readonly toolHeaders: readonly { readonly start: number; readonly tool: TranscriptTool }[];
}

export interface TranscriptMetrics {
	/** 实际写进对话流的行数 */
	readonly totalLines: number;
	/** 加上底部留白后的可滚动行数 */
	readonly scrollLines: number;
	/** 最后一条用户提示的起始行，发送后用它做 page flip */
	readonly lastPromptStart: number;
}

/**
 * 追加一条工具行。
 *
 * 连续两个只读探索工具才收进组；单个工具、写操作、失败行和普通正文都会断开组。运行时
 * 传入 expanded=true 先展开，回合结束时由调用方统一收起。
 *
 * 返回 true 表示把上一条普通工具行换成了组对象；调用方如果维护了另一份行数组，需要整段
 * 同步一次，不能只追加新增行。
 */
export function appendToolLine(
	lines: TranscriptLine[],
	tool: TranscriptTool,
	expanded: boolean,
): boolean {
	if (tool.group === undefined || tool.isError === true) {
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
		last.group !== undefined &&
		last.isError !== true
	) {
		lines[lines.length - 1] = { kind: "toolGroup", members: [last, tool], expanded };
		return true;
	}
	lines.push(tool);
	return false;
}

/** 回合结束：把所有工具组收成一行组头。 */
export function collapseToolGroups(lines: readonly TranscriptLine[]): void {
	for (const line of lines) {
		if (typeof line === "object" && line !== null && line.kind === "toolGroup") {
			line.expanded = false;
		}
	}
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

/** Ctrl+E：展开或收起最近一个思考区块或工具组。 */
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
 * 可滚动的总行数。
 *
 * 底部留白让最后一条提示能停在视口顶部（发送后的 page flip），但它只在内容已经超过一屏时
 * 才有意义。内容不足一屏还留白，滚轮就能滚进一片空白，而滚动条与置底按钮也会跟着指向并不
 * 存在的东西——那正是「没内容却提示回到底部」的来源。
 *
 * 滚动、滚动条、置底按钮、拖动都必须用这一个函数，四处各算一遍迟早对不上。
 */
function scrollableLines(total: number, lastPromptStart: number, rows: number): number {
	if (total <= rows) return total;
	return Math.max(total, lastPromptStart + rows);
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
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];
	if (view.lines.length === 0) return Array.from({ length: rows }, () => "");

	const { top } = scrollState(view, rows, scrollTop);
	const indexes = visibleIndexes(view, rows, top);
	const lineAt = (index: number): string => view.lines[index] ?? " ".repeat(view.width);
	const visible = indexes.map(lineAt);

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

/**
 * 这一行有没有可展开的东西。
 *
 * 命令全文（折叠时被截短的部分）与工具结果都算。`python script.py` 这类命令本身没有被截短，
 * 但它的输出仍然值得看一眼——不能因为「命令没藏东西」就把结果也一起锁在门外。
 * 空输出不算：展开只会得到一行「(no output)」，那不该让人以为这里有东西。
 */
function hasExpandableDetail(tool: TranscriptTool): boolean {
	if (tool.fullDetail !== undefined) return true;
	return tool.result !== undefined && tool.result.trim().length > 0;
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

function lineIndexAtRow(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): number | undefined {
	const rows = Math.max(0, height);
	if (rows === 0 || row < 1 || row > rows) return undefined;

	const { top } = scrollState(view, rows, scrollTop);
	const indexes = visibleIndexes(view, rows, top);
	return indexes[row - 1];
}

function scrollState(
	view: TranscriptView,
	rows: number,
	requestedTop: number,
): { readonly top: number } {
	const total = view.lines.length;
	const lastPromptStart = view.prompts.at(-1)?.start ?? 0;
	// 与 measureTranscriptView 用同一份留白规则，否则渲染窗口和滚动条会各说各话
	const scrollLines = scrollableLines(total, lastPromptStart, rows);
	const maxScroll = Math.max(0, scrollLines - rows);
	return { top: Math.min(Math.max(0, requestedTop), maxScroll) };
}

function visibleIndexes(
	view: TranscriptView,
	rows: number,
	top: number,
): readonly number[] {
	const prompt = pinnedPrompt(view.prompts, top);
	if (prompt !== undefined && top > prompt.start) {
		const full = prompt.height + HEADER_GAP_LINES;
		// 下一条提示逼近时，吸顶块从自己的顶部收起，把下一个提示块完整让出来；
		// 提示前固定留的那行空行留在正文里，块与块之间才不会贴在一起
		const next = view.prompts.find((item) => item.start > prompt.start);
		const budget = next === undefined ? full : next.start - top - 1;
		const headerCount = Math.min(rows, Math.min(full, Math.max(0, budget)));
		if (headerCount > 0) {
			const header = headerIndexes(prompt, headerCount);
			// header 盖住视口顶部；正文接着被盖住的行继续，滚动才始终有位移
			const contentTop = top + headerCount;

			const contentHeight = Math.max(0, rows - headerCount);
			const content = Array.from({ length: contentHeight }, (_, index) => contentTop + index);
			return [...header, ...content];
		}
	}
	return Array.from({ length: rows }, (_, index) => top + index);
}

/**
 * 吸顶块显示提示的哪几行。
 *
 * 满高时连同提示后的空行一起显示；被下一条提示顶出去时只保留提示块末尾的几行，
 * 空行留在正文里给下一个提示块做间隔。
 */
function headerIndexes(prompt: PromptRange, count: number): readonly number[] {
	const start =
		count === prompt.height + HEADER_GAP_LINES
			? prompt.start
			: prompt.start + prompt.height - count;
	return Array.from({ length: count }, (_, index) => start + index);
}

function contentWidth(terminalWidth: number): number {
	return Math.max(0, Math.max(0, terminalWidth) - GUTTER_WIDTH);
}

/** 对话流里可以连成一块的内容类型：同类连续行紧凑排列，块与块之间留空行。 */
type ResponseBlockKind = "text" | "thinking" | "tools" | "notice";

function responseBlockKind(line: TranscriptLine): ResponseBlockKind {
	if (typeof line === "string") return "text";
	if (line.kind === "markdown") return "text";
	if (line.kind === "tool") return line.isError === true ? "notice" : "tools";
	if (line.kind === "toolGroup") return "tools";
	if (line.kind === "thinkingBlock") return "thinking";
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
	return currentKind === "thinking" || currentKind === "notice";
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
				lines.push(...responseLines(line, width, MESSAGE_TEXT_COLOR));
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
			const warning = line.kind === "warning";
			lines.push(
				...wrappedLines(
					warning ? `Warning: ${line.text}` : line.text,
					`${RESPONSE_INDENT}${warning ? "!" : ERROR_MARKER} `,
					width,
					warning ? NOTICE_COLOR : ERROR_COLOR,
				),
			);
		}
		prompts.push({ start, height: promptLines.length, responseStart });
		previousHadResponse = turn.response.length > 0;
	}

	return { width, lines, prompts, thinkingHeaders, groupHeaders, toolHeaders };
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
	if (!block.expanded) {
		return wrappedLines(block.header, THINKING_PREFIX, width, THINKING_COLOR);
	}

	const prefix = THINKING_EXPANDED_PREFIX;
	const label = block.header.startsWith("Thought for ") ? "Thought for " : block.header;
	const prefixWidth = displayWidth(prefix);
	const lines = wrapText(block.header, Math.max(0, width - prefixWidth));
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

/** 思考正文的一行：色带在标题符号右侧留出与工具详情相同的列数，带内留一列内边距。 */
function thinkingBodyLines(text: string, width: number): readonly string[] {
	const start = displayWidth(RESPONSE_INDENT) + DETAIL_BAND_LEFT;
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, width - start);
	// 窄终端上留白不能把正文挤没，宽度不够时让出来
	const insideWidth = innerWidth > MIN_DETAIL_CONTENT ? THINKING_PADDING : 0;
	const inside = " ".repeat(insideWidth);
	const contentWidth = Math.max(1, innerWidth - insideWidth - DETAIL_RIGHT_PADDING);

	return wrapText(text, contentWidth).map((line) => {
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

/**
 * 工具组的屏幕行。
 *
 * 两个以上成员才有组头：运行时展开，回合结束收起；单个成员直接按普通工具行渲染。
 * 同时给出成员标题行在返回行数组里的偏移，供双击命中注册。
 */
function toolGroupLines(
	group: TranscriptToolGroup,
	width: number,
): {
	readonly lines: readonly string[];
	readonly memberStarts: readonly { readonly start: number; readonly tool: TranscriptTool }[];
} {
	const lines: string[] = [];
	const memberStarts: { start: number; tool: TranscriptTool }[] = [];

	if (group.members.length < 2) {
		const [tool] = group.members;
		if (tool === undefined) return { lines, memberStarts };
		memberStarts.push({ start: lines.length, tool });
		lines.push(...toolLines(tool, width));
		if (tool.resultExpanded && tool.result !== undefined) {
			lines.push(...toolResultLines(tool, width));
		}
		return { lines, memberStarts };
	}

	const marker = group.expanded ? TOOL_GROUP_EXPANDED_MARKER : TOOL_MARKER;
	const prefix = `${RESPONSE_INDENT}${marker} `;
	const limit = Math.max(0, width - displayWidth(prefix));
	lines.push(coloredLine(`${prefix}${fitToWidth(groupHeaderLabel(group.members), limit)}`, width, TOOL_GROUP_COLOR));

	if (group.expanded) {
		for (const member of group.members) {
			memberStarts.push({ start: lines.length, tool: member });
			lines.push(...toolLines(member, width, TOOL_GROUP_MEMBER_INDENT));
			if (member.resultExpanded && member.result !== undefined) {
				lines.push(...toolResultLines(member, width, TOOL_GROUP_MEMBER_INDENT));
			}
		}
	}
	return { lines, memberStarts };
}

/** 成功工具结果：缩进在工具行下方，超过预览行数时收敛。 */
function toolResultLines(
	tool: TranscriptTool,
	width: number,
	baseIndent = RESPONSE_INDENT,
): readonly string[] {
	const raw = tool.result ?? "";
	const lines = raw.length === 0 ? ["(no output)"] : raw.split("\n");
	const visible = lines.slice(0, TOOL_RESULT_PREVIEW_LINES);
	const prefix = `${baseIndent}  `;
	// 结果同样是终端文本：Windows 命令带回车，其他工具可能带转义序列
	const output = visible.flatMap((line) =>
		wrappedLines(sanitizeLine(line), prefix, width, THEME.textSecondary),
	);
	if (lines.length > TOOL_RESULT_PREVIEW_LINES) {
		output.push(
			...wrappedLines(
				`… (${lines.length - TOOL_RESULT_PREVIEW_LINES} more lines)`,
				prefix,
				width,
				THEME.textSecondary,
			),
		);
	}
	return output;
}

/** 组头按固定顺序汇总：Read → Listed → Searched。 */
function groupHeaderLabel(members: readonly TranscriptTool[]): string {
	let read = 0;
	let list = 0;
	let search = 0;
	for (const member of members) {
		if (member.group === "read") read += 1;
		else if (member.group === "list") list += 1;
		else if (member.group === "search") search += 1;
	}

	const parts: string[] = [];
	if (read > 0) parts.push(`Read ${read} ${read === 1 ? "file" : "files"}`);
	if (list > 0) parts.push(`Listed ${list} ${list === 1 ? "dir" : "dirs"}`);
	if (search > 0) parts.push(`Searched ${search} ${search === 1 ? "pattern" : "patterns"}`);
	return parts.join(", ");
}

/**
 * 工具调用行。
 *
 * 折叠时只显示核心命令：开头多余的工作根 `cd` 已经由描述模块剥掉。失败时这一行本身变成
 * 错误行（× + 命令 + 耗时），不再另起一行；双击展开完整命令与详细错误。
 */
function toolLines(tool: TranscriptTool, width: number, baseIndent = RESPONSE_INDENT): readonly string[] {
	// 下划线表示「这一行有东西可点开」。已完成又什么都展不开的行连标记也不给——它长得
	// 像能点，实际什么都不会发生。运行中的行仍留着标记：否则箭头会在结果到达那一刻冒出来
	const interactive = tool.linkTarget !== undefined || hasExpandableDetail(tool);
	const finished = tool.result !== undefined || tool.fullDetail !== undefined || tool.isError;
	const marker = tool.isError ? ERROR_MARKER : !finished || interactive ? TOOL_MARKER : "";
	const prefix = marker.length === 0 ? baseIndent : `${baseIndent}${marker} `;
	const limit = Math.max(0, width - displayWidth(prefix));

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

	if (tool.detail.length === 0 && tool.metric === undefined) {
		return [coloredLine(`${prefix}${fitToWidth(tool.name, limit)}`, width, TOOL_NAME_COLOR)];
	}

	return [
		toolSummaryLine(prefix, tool.name, tool.detail, tool.metric, tool.linkTarget, width, interactive),
	];
}

/** 展开的详情色带：上下各留一行，右侧铺到面板边缘。失败行展开时也复用它。 */
function detailBand(tool: TranscriptTool, baseIndent: string, width: number): readonly string[] {
	const bandStart = displayWidth(baseIndent) + DETAIL_BAND_LEFT;
	const kind = tool.detailKind ?? "text";
	// 工具结果普遍以换行结尾，直接切行会在详情末尾多出一个空行，与下边距叠成两行留白
	const rows = stripTrailingBlank((tool.fullDetail ?? "").split("\n"));
	// 只截显示不截数据：全文仍在 tool.fullDetail 里，展开多长都不会把这一轮的其他内容挤出屏幕
	const visible = rows.slice(0, DETAIL_BAND_MAX_LINES);
	const syntax = kind === "diff" ? diffSyntax(visible, tool.detail) : undefined;
	const hidden = rows.length - visible.length;
	return [
		bandBlankLine(width, bandStart),
		...visible.flatMap((line, index) =>
			detailBodyLines(line, kind, width, bandStart, detailColor(kind, line), syntax?.[index]),
		),
		...(hidden === 0
			? []
			: detailBodyLines(
					`… (${hidden} more lines)`,
					"text",
					width,
					bandStart,
					THEME.textSubtle,
					undefined,
				)),
		bandBlankLine(width, bandStart),
	];
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
	const padding = " ".repeat(
		Math.max(0, available - displayWidth(tail) - displayWidth(shownMetric)),
	);
	const metricPart = shownMetric.length === 0 ? "" : `${TOOL_NAME_COLOR}${shownMetric}${RESET}`;
	// 有线 = 这一行能点开。链接与非链接都自己画实线：终端给 OSC 8 链接的装饰可能是
	// 「悬停才画」，静止态就只剩一行没线的文字，和可展开的参数对不上
	const lead = tail.slice(0, 2);
	const body = tail.slice(2);
	const tailPart =
		body.length === 0
			? `${TOOL_NAME_COLOR}${tail}`
			: linkTarget !== undefined
				? `${TOOL_NAME_COLOR}${lead}${UNDERLINE}${osc8Link(linkTarget, body)}`
				: interactive
					? `${TOOL_NAME_COLOR}${lead}${UNDERLINE}${body}`
					: `${TOOL_NAME_COLOR}${tail}`;
	return `${TOOL_NAME_COLOR}${head}${RESET}${tailPart}${RESET}${metricPart}${padding}`;
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

function wrappedLines(
	text: string,
	prefix: string,
	width: number,
	color: string,
): readonly string[] {
	const prefixWidth = displayWidth(prefix);
	const lines = wrapText(text, Math.max(0, width - prefixWidth));
	const continuation = " ".repeat(prefixWidth);

	return lines.map((line, index) =>
		coloredLine(`${index === 0 ? prefix : continuation}${line}`, width, color),
	);
}

function coloredLine(text: string, width: number, color: string): string {
	const visible = truncateToWidth(text, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
	return `${color}${visible}${RESET}${padding}`;
}

/**
 * 去掉末尾的空行。
 *
 * 工具结果常以换行结尾，切行后最后一项是空串；渲染时它会占掉一整行，与面板本来的下边距
 * 叠在一起，看起来就像底部莫名多了两行留白。
 */
function stripTrailingBlank(rows: readonly string[]): readonly string[] {
	let end = rows.length;
	while (end > 0 && (rows[end - 1] ?? "").trim().length === 0) end -= 1;
	return end === rows.length ? rows : rows.slice(0, end);
}

/**
 * 详情行：文件与 diff 带行号，续行按行号后的内容列悬挂缩进；其余按正文折行。
 *
 * bandStart 是色带起点，内容在带内留一列内边距后开始。
 */
function detailBodyLines(
	line: string,
	kind: ResultDetailKind,
	width: number,
	bandStart: number,
	color: string,
	syntax: readonly SyntaxSegment[] | undefined,
): readonly string[] {
	if (kind === "file") {
		const match = /^(\s*\d+  )(.*)$/.exec(line);
		if (match !== null) {
			return hangingLines(
				match[1] ?? "",
				"",
				[{ text: match[2] ?? "", color }],
				width,
				bandStart,
				THEME.surface,
				THEME.textSubtle,
				color,
				DETAIL_RIGHT_PADDING,
			);
		}
	}
	if (kind === "diff") {
		const match = /^(\s*\d+ )([-+] |  )(.*)$/.exec(line);
		if (match !== null) {
			const marker = match[2] ?? "  ";
			// 增删由整行底色表示，代码本身按语法着色；认不出语言时退回正文色
			const background =
				marker === "+ " ? THEME.diffInsertBg : marker === "- " ? THEME.diffDeleteBg : THEME.surface;
			// 行号跟着增删走：一眼能分出这一行的归属，不必来回对标记列
			const markerColor = marker === "+ " ? THEME.success : marker === "- " ? THEME.error : color;
			const segments =
				syntax === undefined
					? [{ text: match[3] ?? "", color }]
					: syntax.map((segment) => ({ text: segment.text, color: syntaxColor(segment.token) }));
			return hangingLines(
				match[1] ?? "",
				marker,
				segments,
				width,
				bandStart,
				background,
				markerColor,
				markerColor,
				DETAIL_RIGHT_PADDING,
			);
		}
	}
	return bandedWrappedLines(
		line,
		width,
		color,
		bandStart,
		DETAIL_RIGHT_PADDING,
	);
}

/**
 * diff 里的代码着色。
 *
 * 一份 diff 交错着两个版本：删行属于旧文件、增行属于新文件。块注释、模板字符串这类跨行结构
 * 必须各自在自己的版本里解析，否则颜色会在增删交界处串味，因此新旧两侧各解析一次再按行映射
 * 回来。认不出语言时返回 undefined，调用方按纯文本渲染。
 *
 * fileName 是折叠行里的文件名：语言只按扩展名判断，去掉目录不影响结论。
 */
function diffSyntax(
	rows: readonly string[],
	fileName: string,
): readonly (readonly SyntaxSegment[] | undefined)[] | undefined {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	const slots: ({ readonly side: "old" | "new"; readonly index: number } | undefined)[] = [];

	for (const row of rows) {
		const match = /^(\s*\d+ )([-+] |  )(.*)$/.exec(row);
		if (match === null) {
			slots.push(undefined);
			continue;
		}
		const marker = match[2] ?? "  ";
		const text = match[3] ?? "";
		if (marker === "- ") {
			slots.push({ side: "old", index: oldLines.length });
			oldLines.push(text);
			continue;
		}
		// 新增行与上下文行都属于新版本；上下文行同时补进旧版本，两侧才能保持完整
		slots.push({ side: "new", index: newLines.length });
		newLines.push(text);
		if (marker === "  ") oldLines.push(text);
	}

	const oldParsed = oldLines.length === 0 ? undefined : highlightCode(oldLines.join("\n"), fileName);
	const newParsed = newLines.length === 0 ? undefined : highlightCode(newLines.join("\n"), fileName);
	if (oldParsed === undefined && newParsed === undefined) return undefined;

	return slots.map((slot) => {
		if (slot === undefined) return undefined;
		return (slot.side === "old" ? oldParsed : newParsed)?.[slot.index];
	});
}

/** 面板上下内边距：整条色带，不写内容。 */
function bandBlankLine(width: number, bandStart: number): string {
	const start = Math.max(0, Math.min(bandStart, width));
	const lead = " ".repeat(start);
	return `${lead}${THEME.surface}${" ".repeat(Math.max(0, width - start))}${RESET}`;
}

/** 带行号的行换行时，续行缩进到行号之后的内容列。 */
function hangingLines(
	gutter: string,
	marker: string,
	segments: readonly ColoredSegment[],
	width: number,
	bandStart: number,
	background: string,
	gutterColor: string,
	markerColor: string,
	rightPadding: number,
): readonly string[] {
	const start = Math.max(0, Math.min(bandStart, width));
	const contentEnd = Math.max(start, width - rightPadding);
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, contentEnd - start);

	// 行号与增删标记属于刻度而不是内容，压暗后正文才成为视觉主体。
	// 终端过窄时前缀会宽过整条色带：此时按「留白 → 行号 → 标记」依次让步，
	// 至少给正文留一列，否则整行会被推出终端宽度，或者正文整段消失。
	const minContent = Math.min(MIN_DETAIL_CONTENT, innerWidth);
	let head = "";
	let headWidth = 0;
	const append = (text: string, color: string | undefined): void => {
		if (text.length === 0) return;
		const room = innerWidth - minContent - headWidth;
		if (room <= 0) return;
		const visible = truncateToWidth(text, room);
		if (visible.length === 0) return;
		head += color === undefined ? visible : `${color}${visible}`;
		headWidth += displayWidth(visible);
	};
	append(" ", undefined);
	// 行号跟随增删色：改动的归属看一眼行号列就够，不必再去对标记
	append(gutter, gutterColor);
	append(marker, markerColor);

	const available = Math.max(1, innerWidth - headWidth);
	const wrapped = wrapSegments(segments, available);
	const continuation = " ".repeat(headWidth);

	return wrapped.map((line, index) => {
		const body = paintSegments(index === 0 ? head : continuation, headWidth, line, innerWidth);
		// 底色要铺满整行：行尾补齐用背景色而不是文字色，否则尾部会拖一条彩色的空白
		const padding = " ".repeat(Math.max(0, width - start - body.width));
		return `${lead}${background}${body.text}${padding}${RESET}`;
	});
}

/** 详情行换行后同样从 bandStart 列开始铺色带，带内留一列内边距。 */
function bandedWrappedLines(
	text: string,
	width: number,
	color: string,
	bandStart: number,
	rightPadding: number,
): readonly string[] {
	const start = Math.max(0, Math.min(bandStart, width));
	const contentEnd = Math.max(start, width - rightPadding);
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, contentEnd - start);
	// 带内留白由这里固定给出一列，不能从前缀里推导：色带起点一变，前缀就会被切光。
	// 但窄终端上留白不能把正文挤没，宽度不够时让出来。
	const insideWidth = innerWidth > MIN_DETAIL_CONTENT ? 1 : 0;
	const inside = " ".repeat(insideWidth);
	const lines = wrapText(text, Math.max(0, innerWidth - insideWidth));
	const continuation = inside;

	return lines.map((line, index) => {
		const content = `${index === 0 ? inside : continuation}${line}`;
		const visible = truncateToWidth(content, innerWidth);
		// 空行与 hunk 之间的省略行不写内容，只留底色；给它们上文字色会在整行铺出一片色块
		const paint = visible.trim().length === 0 ? "" : color;
		const padding = " ".repeat(Math.max(0, width - start - displayWidth(visible)));
		return `${lead}${THEME.surface}${paint}${visible}${padding}${RESET}`;
	});
}

/** 详情行的颜色：diff 的增、删分别着色，省略行弱化，文件内容用次要文字色。 */
function detailColor(kind: ResultDetailKind, line: string): string {
	if (kind === "diff") {
		// 带行号的 diff 形如 `12 + added` / `12 - removed`
		const marker = /^\s*\d+ ([-+]) /.exec(line);
		if (marker !== null) return marker[1] === "+" ? THEME.success : THEME.error;
		// 两个 hunk 之间的省略行不是正文，弱化到背景里
		if (line.trimStart().startsWith("…")) return THEME.textSubtle;
		if (line.startsWith("+")) return THEME.success;
		if (line.startsWith("-")) return THEME.error;
		return THEME.textSecondary;
	}
	if (kind === "file") return THEME.textSecondary;
	return MESSAGE_TEXT_COLOR;
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
		return `${PROMPT_BG}${MESSAGE_TEXT_COLOR}${prefix}${text}${padding}${RESET}`;
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
	const firstPrefix = `${RESPONSE_INDENT}! `;
	const continuationPrefix = " ".repeat(displayWidth(firstPrefix));
	const limit = Math.max(0, width - displayWidth(firstPrefix));

	return wrapText(text, limit).map((line, index) => {
		const prefix = index === 0 ? firstPrefix : continuationPrefix;
		const visible = truncateToWidth(prefix + line, width);
		const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
		return `${NOTICE_COLOR}${visible}${padding}${RESET}`;
	});
}

function responseLines(text: string, width: number, color: string): readonly string[] {
	const prefixWidth = Math.min(RESPONSE_INDENT.length, width);
	const lines = wrapText(text, Math.max(0, width - prefixWidth));

	return lines.map((line) => {
		const content = truncateToWidth(RESPONSE_INDENT + line, width);
		const padding = " ".repeat(Math.max(0, width - displayWidth(content)));
		return `${color}${content}${padding}${RESET}`;
	});
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

/**
 * 按显示宽度折行，保留每段的颜色。
 *
 * 着色后的代码由多段不同颜色拼成，先摊成字符再按宽度切断，切点落在段中间时要把这段拆开，
 * 否则整段会因为放不下而被整体推到下一行，行宽就白算了。
 */
function wrapSegments(segments: readonly ColoredSegment[], limit: number): readonly (readonly ColoredSegment[])[] {
	if (limit <= 0) return [[]];

	const lines: ColoredSegment[][] = [[]];
	let used = 0;

	for (const segment of segments) {
		for (const char of segment.text) {
			const charWidth = characterWidth(char);
			if (used + charWidth > limit && used > 0) {
				lines.push([]);
				used = 0;
			}
			appendColored(lines[lines.length - 1] ?? [], char, segment.color);
			used += charWidth;
		}
	}
	return lines;
}

/** 相邻同色字符合并，避免输出里出现大量只有一两个字符的转义序列。 */
function appendColored(line: ColoredSegment[], text: string, color: string): void {
	const last = line.at(-1);
	if (last !== undefined && last.color === color) {
		line[line.length - 1] = { text: last.text + text, color };
		return;
	}
	line.push({ text, color });
}

/**
 * 把前缀与彩色正文拼成一行，并按宽度截断。
 *
 * 截断必须按字符进行：着色后每段都带转义序列，按字符串长度一刀切会把转义序列截成半截，
 * 终端上就会出现整屏乱码。正文结束后回到背景色，行尾填充才不会拖着文字色。
 */
function paintSegments(
	prefix: string,
	prefixWidth: number,
	segments: readonly ColoredSegment[],
	limit: number,
): { readonly text: string; readonly width: number } {
	let remaining = Math.max(0, limit - prefixWidth);
	let output = prefix;
	let width = prefixWidth;

	for (const segment of segments) {
		if (remaining <= 0) break;
		const visible = truncateToWidth(segment.text, remaining);
		if (visible.length === 0) continue;
		output += `${segment.color}${visible}`;
		width += displayWidth(visible);
		remaining -= displayWidth(visible);
	}
	return { text: output, width };
}

function pinnedPrompt(prompts: readonly PromptRange[], top: number): PromptRange | undefined {
	let found: PromptRange | undefined;
	for (const prompt of prompts) {
		if (prompt.start <= top) found = prompt;
		else break;
	}
	return found;
}

/**
 * 滚动条那一列。
 *
 * 调用方除了把它拼在每行末尾，还要在画完内容之后按自己的行列位置重画一遍：一行是否被终端
 * 换行取决于终端把每个字符算几列（不同终端对歧义宽度字符的处理并不一致），跟着内容一起画的
 * 那一列会被带到别处。单独重画时它只依赖自己的行列，内容怎么换行都不影响。
 */
export function scrollbarColumn(height: number, scrollLines: number, top: number): readonly string[] {
	// 内容没有超出视口时没有可滚动的东西，整列留空，不画轨道和滑块
	if (scrollLines <= height) return Array.from({ length: height }, () => " ");

	const thumb = scrollbarThumb(height, scrollLines);
	const maxScroll = Math.max(1, scrollLines - height);
	const thumbTop = Math.round((Math.min(Math.max(0, top), maxScroll) / maxScroll) * thumb.maxTop);

	return Array.from({ length: height }, (_, row) => {
		const char = row >= thumbTop && row < thumbTop + thumb.height ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
		return `${SCROLLBAR_COLOR}${char}${RESET}`;
	});
}

/**
 * 滑块的高度与可移动范围。
 *
 * 绘制与拖动共用这一份几何。两边各算一遍的话，拖到哪滑块都不在光标下。
 */
export function scrollbarThumb(
	height: number,
	scrollLines: number,
): { readonly height: number; readonly maxTop: number } {
	if (scrollLines <= height) return { height, maxTop: 0 };
	const size = Math.min(height, Math.max(1, Math.floor((height * height) / Math.max(1, scrollLines))));
	return { height: size, maxTop: Math.max(0, height - size) };
}

/**
 * 拖动滚动条：让滑块中心落在光标那一行，再换算成 scrollTop。
 *
 * 先按滑块自己的行坐标求出它该停在哪，最后才换算成滚动量。不能直接拿整列高度线性换算——
 * 滑块只占其中一段、也只能移动一段，按整列算的话光标与滑块对不上。
 */
export function scrollTopForRow(row: number, height: number, maxScroll: number): number {
	if (maxScroll <= 0 || height <= 1) return 0;

	const thumb = scrollbarThumb(height, maxScroll + height);
	if (thumb.maxTop === 0) return 0;

	const top = Math.min(Math.max(0, row - 1 - Math.floor(thumb.height / 2)), thumb.maxTop);
	return Math.round((top / thumb.maxTop) * maxScroll);
}
