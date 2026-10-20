import { eastAsianWidth } from "get-east-asian-width";

import type { ToolGroupKind } from "../tools/describe.ts";
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
	| TranscriptToolGroup;

/** 需要与正文区分开的一行：警告和失败是要看见的事。 */
export interface TranscriptNote {
	readonly text: string;
	readonly kind: "error" | "warning";
}

/**
 * 工具调用行。
 *
 * name 与 detail 已经由工具描述模块转成给人看的文字；渲染只负责排版。失败时 detail 是
 * 失败原因，整行用错误色并带上耗时。
 */
export interface TranscriptTool {
	readonly kind: "tool";
	readonly name: string;
	readonly detail: string;
	readonly isError?: boolean;
	readonly durationMs?: number;
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
/** 思考标题的标记：单列火花，与工具行的 ›、失败行的 × 区分。 */
const THINKING_MARKER = "✻";
/** 思考标题的缩进；正文缩进到与 Think…/Thought… 的首字对齐。 */
const THINKING_PREFIX = `${RESPONSE_INDENT}${THINKING_MARKER} `;
const THINKING_BODY_INDENT = " ".repeat(displayWidth(THINKING_PREFIX));
/** 工具调用沿用用户提示的标记，两类条目在同一列起头。 */
const TOOL_MARKER = "›";
/** 展开的工具组用带心菱形；收起时沿用工具行的 ›。 */
const TOOL_GROUP_EXPANDED_MARKER = "◈";
/** 工具组成员比组头多缩进两格。 */
const TOOL_GROUP_MEMBER_INDENT = `${RESPONSE_INDENT}  `;
/** 错误行的标记：与工具失败行共用，错误消息因此有一致的起头。 */
const ERROR_MARKER = "×";
const PROMPT_MAX_LINES = 3;
const HEADER_GAP_LINES = 1;
/** 右侧固定预留一列空隙和一列滚动条。 */
const GUTTER_WIDTH = 2;

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
		scrollLines: Math.max(view.lines.length, lastPromptStart + rows),
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
	// 底部补白让最后一条提示可以停在视口顶部，这正是发送后的 page flip
	const scrollLines = Math.max(total, lastPromptStart + rows);
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
		const headerCount = Math.min(prompt.height + HEADER_GAP_LINES, rows);
		const header = Array.from({ length: headerCount }, (_, index) => prompt.start + index);
		// header 盖住视口顶部；正文接着被盖住的行继续，滚动才始终有位移
		const contentTop = top + header.length;

		const contentHeight = Math.max(0, rows - header.length);
		const content = Array.from({ length: contentHeight }, (_, index) => contentTop + index);
		return [...header, ...content];
	}
	return Array.from({ length: rows }, (_, index) => top + index);
}

function contentWidth(terminalWidth: number): number {
	return Math.max(0, Math.max(0, terminalWidth) - GUTTER_WIDTH);
}

function build(width: number, turns: readonly TranscriptTurn[], notice: string | undefined): TranscriptView {
	const lines: string[] = [];
	const prompts: PromptRange[] = [];
	const thinkingHeaders: { start: number; block: TranscriptThinking }[] = [];
	const groupHeaders: { start: number; group: TranscriptToolGroup }[] = [];
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
		for (const line of turn.response) {
			if (typeof line === "string") {
				lines.push(...responseLines(line, width, MESSAGE_TEXT_COLOR));
				continue;
			}
			if (line.kind === "thinkingBlock") {
				const blockStart = lines.length;
				lines.push(...thinkingBlockLines(line, width));
				thinkingHeaders.push({ start: blockStart, block: line });
				continue;
			}
			if (line.kind === "tool") {
				lines.push(...toolLines(line, width));
				if (line.resultExpanded && line.result !== undefined) {
					lines.push(...toolResultLines(line, width));
				}
				continue;
			}
			if (line.kind === "toolGroup") {
				const groupStart = lines.length;
				lines.push(...toolGroupLines(line, width));
				// 单个成员直接按普通工具行渲染，没有组头可点
				if (line.members.length >= 2) groupHeaders.push({ start: groupStart, group: line });
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

	return { width, lines, prompts, thinkingHeaders, groupHeaders };
}

/**
 * 思考区块的屏幕行。
 *
 * 标题带 ✻、不铺底色；正文缩进到标题首字，只有正文本身铺一层弱底色，从左到右填满内容区。
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
	return [...thinkingHeaderLines(block, width), ...visible];
}

/**
 * 思考区块的标题行。
 *
 * 展开时只提亮 `✻ Thought for` 这段可点击的标签，耗时继续用弱化色；收起时整行弱化。
 */
function thinkingHeaderLines(block: TranscriptThinking, width: number): readonly string[] {
	if (!block.expanded) {
		return wrappedLines(block.header, THINKING_PREFIX, width, THINKING_COLOR);
	}

	const label = block.header.startsWith("Thought for ") ? "Thought for " : block.header;
	const prefixWidth = displayWidth(THINKING_PREFIX);
	const lines = wrapText(block.header, Math.max(0, width - prefixWidth));
	let offset = 0;

	return lines.map((line, index) => {
		const lead = index === 0 ? THINKING_PREFIX : " ".repeat(prefixWidth);
		const activeWidth = Math.max(0, Math.min(line.length, label.length - offset));
		const active = line.slice(0, activeWidth);
		const rest = line.slice(activeWidth);
		offset += line.length;
		const visible = `${lead}${active}${rest}`;
		const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
		return `${THINKING_ACTIVE_COLOR}${lead}${active}${THINKING_COLOR}${rest}${RESET}${padding}`;
	});
}

/** 思考正文的一行：缩进不铺底色，从内容首字开始一直铺到右边界。 */
function thinkingBodyLines(text: string, width: number): readonly string[] {
	const indentWidth = displayWidth(THINKING_BODY_INDENT);
	const contentWidth = Math.max(0, width - indentWidth);

	return wrapText(text, contentWidth).map((line) => {
		const visible = truncateToWidth(line, contentWidth);
		const padding = " ".repeat(Math.max(0, contentWidth - displayWidth(visible)));
		return `${THINKING_BODY_INDENT}${THINKING_BG}${THINKING_COLOR}${visible}${padding}${RESET}`;
	});
}

/**
 * 工具组的屏幕行。
 *
 * 两个以上成员才有组头：运行时展开，回合结束收起；单个成员直接按普通工具行渲染。
 */
function toolGroupLines(group: TranscriptToolGroup, width: number): readonly string[] {
	if (group.members.length < 2) {
		const [tool] = group.members;
		if (tool === undefined) return [];
		return [
			...toolLines(tool, width),
			...(tool.resultExpanded && tool.result !== undefined ? toolResultLines(tool, width) : []),
		];
	}

	const marker = group.expanded ? TOOL_GROUP_EXPANDED_MARKER : TOOL_MARKER;
	const prefix = `${RESPONSE_INDENT}${marker} `;
	const limit = Math.max(0, width - displayWidth(prefix));
	const lines = [coloredLine(`${prefix}${fitToWidth(groupHeaderLabel(group.members), limit)}`, width, TOOL_GROUP_COLOR)];

	if (group.expanded) {
		for (const member of group.members) {
			lines.push(...toolLines(member, width, TOOL_GROUP_MEMBER_INDENT));
			if (member.resultExpanded && member.result !== undefined) {
				lines.push(...toolResultLines(member, width, TOOL_GROUP_MEMBER_INDENT));
			}
		}
	}
	return lines;
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
	const output = visible.flatMap((line) => wrappedLines(line, prefix, width, THEME.textSecondary));
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
 * 名称加参数放得下就是一行；放不下时名称独占一行，参数缩进到下一行，再长就省略，保持最多
 * 两行。失败原因要完整看见，过长按普通正文换行，每行都用错误色。
 */
function toolLines(tool: TranscriptTool, width: number, baseIndent = RESPONSE_INDENT): readonly string[] {
	const marker = tool.isError ? ERROR_MARKER : TOOL_MARKER;
	const prefix = `${baseIndent}${marker} `;
	const limit = Math.max(0, width - displayWidth(prefix));

	if (tool.isError) {
		const duration = tool.durationMs === undefined ? "" : ` (${tool.durationMs}ms)`;
		const body = tool.detail.length === 0 ? tool.name : `${tool.name}  ${tool.detail}`;
		return wrappedLines(body + duration, prefix, width, ERROR_COLOR);
	}

	if (tool.detail.length === 0) {
		return [coloredLine(`${prefix}${fitToWidth(tool.name, limit)}`, width, TOOL_NAME_COLOR)];
	}

	if (displayWidth(`${tool.name}  ${tool.detail}`) <= limit) {
		return [toolSummaryLine(prefix, tool.name, tool.detail, width)];
	}

	const continuation = " ".repeat(displayWidth(prefix));
	return [
		coloredLine(`${prefix}${fitToWidth(tool.name, limit)}`, width, TOOL_NAME_COLOR),
		coloredLine(
			`${continuation}${fitToWidth(tool.detail, Math.max(0, width - displayWidth(continuation)))}`,
			width,
			MESSAGE_TEXT_COLOR,
		),
	];
}

/** 一行同时有两种颜色：标记与名称弱化，参数用正文色。 */
function toolSummaryLine(prefix: string, name: string, detail: string, width: number): string {
	const head = truncateToWidth(`${prefix}${name}`, width);
	const headWidth = displayWidth(head);
	const tail = truncateToWidth(`  ${detail}`, Math.max(0, width - headWidth));
	const padding = " ".repeat(Math.max(0, width - headWidth - displayWidth(tail)));
	return `${TOOL_NAME_COLOR}${head}${RESET}${MESSAGE_TEXT_COLOR}${tail}${RESET}${padding}`;
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

/** 截到指定宽度；放不下时末尾补省略号，保证结果不超过宽度。 */
function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;

	const chars = Array.from(text);
	let used = 0;
	let end = 0;
	while (end < chars.length) {
		const charWidth = characterWidth(chars[end] ?? "");
		if (used + charWidth > width - 1) break;
		used += charWidth;
		end += 1;
	}
	return `${chars.slice(0, end).join("")}…`;
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

function wrapText(text: string, limit: number): string[] {
	if (limit <= 0) return [""];

	const chars = Array.from(text);
	const lines: string[] = [];
	let line = "";
	let used = 0;

	for (const char of chars) {
		const charWidth = characterWidth(char);
		if (used + charWidth > limit && line.length > 0) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += char;
		used += charWidth;
	}

	lines.push(line);
	return lines;
}

function truncateToWidth(text: string, width: number): string {
	const chars = Array.from(text);
	let used = 0;
	let end = 0;

	while (end < chars.length) {
		const charWidth = characterWidth(chars[end]);
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	return chars.slice(0, end).join("");
}

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += characterWidth(char);
	return width;
}

function characterWidth(char: string): number {
	return eastAsianWidth(char.codePointAt(0) ?? 0);
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
export function scrollbarColumn(height: number, total: number, top: number): readonly string[] {
	// 内容没有超出视口时没有可滚动的东西，整列留空，不画轨道和滑块
	if (total <= height) return Array.from({ length: height }, () => " ");

	const thumbHeight = Math.min(height, Math.max(1, Math.floor((height * height) / Math.max(1, total))));
	const maxThumbTop = Math.max(0, height - thumbHeight);
	const maxScroll = Math.max(1, total - height);
	const thumbTop = Math.round((Math.min(Math.max(0, top), maxScroll) / maxScroll) * maxThumbTop);

	return Array.from({ length: height }, (_, row) => {
		const char = row >= thumbTop && row < thumbTop + thumbHeight ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
		return `${SCROLLBAR_COLOR}${char}${RESET}`;
	});
}
