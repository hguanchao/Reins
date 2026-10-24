import { sanitizeLine, type ToolGroupKind } from "../tools/describe.ts";
import { formatCompactTokens, formatDuration } from "../tools/format.ts";
import { resultDetail, resultMetric, type ResultDetailKind } from "../tools/result-summary.ts";
import { highlightCode, type SyntaxSegment } from "../tools/syntax.ts";
import { renderMarkdown } from "./markdown.ts";
import { swept, type AnimationFrame } from "./sweep.ts";
import { syntaxColor } from "./syntax-style.ts";
import {
	characterWidth,
	coloredLine,
	displayWidth,
	fitToWidth,
	truncateToWidth,
	wrapText,
	wrappedLines,
} from "./text.ts";
import { THEME } from "./theme.ts";
import { todoCardLines, type TranscriptTodo } from "./todo-card.ts";

/** 子代理的一次运行的终态:组清单与单个调用行都从这里渲染。 */
export interface SubagentRunView {
	/** 派发时的任务描述,清单行的正文位 */
	readonly task: string;
	/** running 之外都是终态;结果到达与回合冻结都会改写它,因此可变 */
	status: "running" | "done" | "failed";
	/** 总耗时;终态定格,运行中由界面按 startedAt 每帧重算 */
	durationMs?: number;
	/** 本次委派的请求步数;结果到达时落定 */
	steps?: number;
	/** 本次委派消耗的 token 总量;结果到达时落定 */
	totalTokens?: number;
	/** 完整失败原因;清单行只显示任务名,双击失败行展开看这里 */
	failure?: string;
	/** 失败行是否已展开;双击切换 */
	expanded?: boolean;
}

/**
 * 同一回合内多个子代理调用的组。
 *
 * 组头恒为 ›(展开 ◈),计数段按 running→done→failed 顺序实时翻新;清单用任务卡片的
 * 四态符号语言,纯展示不可再展开——子代理的过程细节不进主对话流。
 */
export interface TranscriptSubagentGroup {
	readonly kind: "subagentGroup";
	readonly members: (SubagentRunView & { readonly callId: string })[];
	/** 组的第一个子代理的派发时刻;运行中耗时由此起算 */
	readonly startedAt: number;
	/** 组的总耗时;全部结束时定格 */
	durationMs?: number;
	/** 组内各子代理的 token 合计;全部结束时定格 */
	totalTokens?: number;
	expanded: boolean;
}

/**
 * 对话流渲染。
 *
 * 用户提示作为吸顶区块：发送后落在视口顶部，回复在它下方增长；
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
	| TranscriptSubagentGroup
	| TranscriptTodo
	| TranscriptMarkdown;

/** 运行中的子代理清单行：渲染期按当前帧重建转圈与扫光。 */
interface LiveSubagentLine {
	readonly indent: string;
	readonly label: string;
	readonly summary: string;
}

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

/**
 * 需要与正文区分开的一行。
 *
 * error 与 warning 是要让人看见的问题；info 是中性的过程说明（比如使用者主动停下），
 * 用弱化色，不该按错误对待。
 */
export interface TranscriptNote {
	readonly text: string;
	readonly kind: "error" | "warning" | "info";
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
	/** 工具分组类型：只读探索工具即时成组；命令延迟到回合结束成组；写操作与失败行没有 */
	readonly group?: ToolGroupKind;
	/** 成功结果全文；展开时显示 */
	result?: string;
	/** 是否在对话流里展开结果 */
	resultExpanded?: boolean;
}

/**
 * 连续同类工具调用的组合。
 *
 * 只读探索组运行时展开显示成员，回合结束折叠成一行组头；命令组只在回合结束时由够数的
 * 连续命令塌成，收起态。双击组头切换。成员保留完整工具行，展开时不丢信息。
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
/** 连续命令至少多少条才塌成命令组：短序列逐行更直观，长序列才值得收成一行。 */
const COMMAND_GROUP_MIN = 5;
/** 错误行的标记：与工具失败行共用，错误消息因此有一致的起头。 */
const ERROR_MARKER = "×";
/** 子代理组头的固定标签。 */
const SUBAGENT_GROUP_LABEL = "Subagents";
/** 子代理组清单的缩进:比组头正文深两列,与工具组成员同一节奏。 */
const SUBAGENT_ITEM_INDENT = `${RESPONSE_INDENT}  `;
/** 清单里任务摘要的显示宽度上限,超出省略。 */
const SUBAGENT_TASK_WIDTH = 34;
/** 待办与待派发子代理的标记:还没有可汇报的结局。 */
const SUBAGENT_PENDING_MARKER = "○";
/**
 * 子代理的配色分工:组头标签与清单标签是青色(清单标签加粗),其余文字一律灰——
 * 一屏里抢眼的只有「有几个代理、各自叫什么」。失败是唯一的例外:整行失败色。
 */
const SUBAGENT_HEAD_COLOR = THEME.accent;
const SUBAGENT_RUNNING_COLOR = THEME.accent;
const SUBAGENT_TEXT_COLOR = THEME.textSecondary;
const SUBAGENT_COUNT_COLOR = THEME.textSecondary;
const SUBAGENT_FAILED_COLOR = THEME.error;
/** 加粗:清单标签是全行焦点。 */
const SUBAGENT_BOLD = "\x1b[1m";
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
/**
 * 制表符宽度。
 *
 * 终端只会把光标跳到下一个制表位，不会为跳过的格子补底色；详情色带因此会在缩进处断开。
 * 上屏前统一展开成空格，行宽计算与背景填充才一致。
 */
const TAB_STOP = 4;

interface PromptRange {
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
	/**
	 * 运行中子代理清单行的动画原料：lines 行号 → 重建所需的内容。
	 *
	 * lines 里先放静态占位行（行数一致），渲染期由调用方带当前帧重建为转圈与扫光。
	 * 这样 100ms 一帧的动画不需要重建整份视图。
	 */
	readonly liveLines: ReadonlyMap<number, LiveSubagentLine>;
	/** 每张收尾任务卡的头行在 lines 里的起点，双击收起/展开使用 */
	readonly todoHeaders: readonly { readonly start: number; readonly card: TranscriptTodo }[];
	/** 每个子代理组头在 lines 里的起点，双击收起/展开使用 */
	readonly subagentHeaders: readonly {
		readonly start: number;
		readonly group: TranscriptSubagentGroup;
	}[];
	/** 每条失败的子代理清单行在 lines 里的起点，双击展开/收起失败原因使用 */
	readonly subagentFailureRows: readonly {
		readonly start: number;
		readonly group: TranscriptSubagentGroup;
		readonly callId: string;
	}[];
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
	const metric =
		name === "bash" && durationMs !== undefined
			? formatDuration(durationMs)
			: resultMetric(name, details, content);
	if (metric !== undefined) tool.metric = metric;
	const detail = resultDetail(name, content, details, tool.detail);
	if (detail !== undefined) {
		tool.fullDetail = detail.text;
		tool.detailKind = detail.kind;
	}
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
	frame?: AnimationFrame,
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

/** 命中收尾任务卡的头行；双击在收起与展开之间切换。 */
export function todoHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptTodo | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.todoHeaders.find((header) => header.start === lineIndex)?.card;
}

/** 命中子代理组头；双击在收起与展开之间切换。 */
export function subagentGroupHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptSubagentGroup | undefined {
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
): { readonly group: TranscriptSubagentGroup; readonly callId: string } | undefined {
	const lineIndex = lineIndexAtRow(view, height, scrollTop, row);
	if (lineIndex === undefined) return undefined;
	return view.subagentFailureRows.find((entry) => entry.start === lineIndex);
}

/**
 * 子代理组的屏幕行。
 *
 * 收起只有组头一行:标签 + 按 running→done→failed 顺序的计数段 + 括号耗时。
 * 展开追加剧清单一行一条,符号沿用任务卡片的四态语言;清单纯展示。
 * 运行中的耗时与计数由 layout 的 100ms 帧刷新:组行不进 liveLines,
 * 每次 spinner tick 直接 markTranscriptDirty 让视图重建(每轮只有一个组,重建便宜)。
 */
function subagentGroupLines(
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
function animatedSubagentLine(
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
type ResponseBlockKind = "text" | "thinking" | "tools" | "todo" | "notice";

function responseBlockKind(line: TranscriptLine): ResponseBlockKind {
	if (typeof line === "string") return "text";
	if (line.kind === "markdown") return "text";
	if (line.kind === "tool") return line.isError === true ? "notice" : "tools";
	if (line.kind === "toolGroup") return "tools";
	if (line.kind === "thinkingBlock") return "thinking";
	if (line.kind === "todo") return "todo";
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
	// 思考、任务卡与失败、警告各自独立成块：即使前后同类也要分开，否则读起来会糊成一片
	return currentKind === "thinking" || currentKind === "todo" || currentKind === "notice";
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
	const todoHeaders: { start: number; card: TranscriptTodo }[] = [];
	const subagentHeaders: { start: number; group: TranscriptSubagentGroup }[] = [];
	const subagentFailureRows: { start: number; group: TranscriptSubagentGroup; callId: string }[] = [];
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
			if (line.kind === "subagentGroup") {
				const groupStart = lines.length;
				subagentHeaders.push({ start: groupStart, group: line });
				const rendered = subagentGroupLines(line, width, liveLines, groupStart);
				lines.push(...rendered.lines);
				// 失败行登记双击命中:展开/收起失败原因
				for (const failure of rendered.failureRows) {
					subagentFailureRows.push({ start: groupStart + failure.start, group: line, callId: failure.callId });
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

	return { width, lines, prompts, thinkingHeaders, groupHeaders, toolHeaders, liveLines, todoHeaders, subagentHeaders, subagentFailureRows };
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

/**
 * 成功工具的结果。
 *
 * 与展开的命令全文用同一条色带：两者都是「这一行摊开后的内容」，样式不同会让人以为
 * 其中一种没有展开。结果同样是终端文本——Windows 命令带回车，其他工具可能带转义序列，
 * 先清洗再上屏。
 */
function toolResultLines(
	tool: TranscriptTool,
	width: number,
	baseIndent = RESPONSE_INDENT,
): readonly string[] {
	const raw = tool.result ?? "";
	const rows = stripTrailingBlank((raw.length === 0 ? "(no output)" : raw).split("\n"));
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
					`… (${hidden} more lines)`,
					width,
					THEME.textSubtle,
					bandStart,
					DETAIL_RIGHT_PADDING,
				)),
		bandBlankLine(width, bandStart),
	];
}

/** 组头按固定顺序汇总：Read → Listed → Searched。 */
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

	const parts: string[] = [];
	if (read > 0) parts.push(`Read ${read} ${read === 1 ? "file" : "files"}`);
	if (list > 0) parts.push(`Listed ${list} ${list === 1 ? "dir" : "dirs"}`);
	if (search > 0) parts.push(`Searched ${search} ${search === 1 ? "pattern" : "patterns"}`);
	if (command > 0) parts.push(`Ran ${command} ${command === 1 ? "command" : "commands"}`);
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
	const visible = rows.slice(0, DETAIL_BAND_MAX_LINES).map(expandTabs);
	const syntax =
		kind === "diff"
			? diffSyntax(visible, tool.detail)
			: kind === "file"
				? fileSyntax(visible, tool.detail)
				: undefined;
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

/** 按固定制表位展开制表符；换行由调用方先切好，这里只处理行内。 */
function expandTabs(text: string): string {
	let column = 0;
	let output = "";
	for (const char of text) {
		if (char === "\t") {
			const width = TAB_STOP - (column % TAB_STOP);
			output += " ".repeat(width);
			column += width;
			continue;
		}
		output += char;
		column += characterWidth(char);
	}
	return output;
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
			const segments =
				syntax === undefined
					? [{ text: match[2] ?? "", color }]
					: syntax.map((segment) => ({
							text: segment.text,
							// 没有角色的标点保持正文色，别把整行提亮成白色
							color: segment.token === undefined ? color : syntaxColor(segment.token),
						}));
			return hangingLines(
				match[1] ?? "",
				"",
				segments,
				width,
				bandStart,
				THEME.detailBg,
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
				marker === "+ " ? THEME.diffInsertBg : marker === "- " ? THEME.diffDeleteBg : THEME.detailBg;
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

/**
 * 文件内容的语法着色。
 *
 * 带行号的正文按行号后的内容列重建整段代码再解析，行号与省略行不进入源码：跨行结构
 * 只有整段解析才能判对。行号宽度由预览层决定，这里只按「数字 + 两个空格」剥离。
 */
function fileSyntax(
	rows: readonly string[],
	fileName: string,
): readonly (readonly SyntaxSegment[] | undefined)[] | undefined {
	const code: string[] = [];
	const slots: (number | undefined)[] = [];
	for (const row of rows) {
		const match = /^\s*\d+  (.*)$/.exec(row);
		if (match === null) {
			slots.push(undefined);
			continue;
		}
		slots.push(code.length);
		code.push(match[1] ?? "");
	}
	if (code.length === 0) return undefined;

	const parsed = highlightCode(code.join("\n"), fileName);
	if (parsed === undefined) return undefined;
	return slots.map((slot) => (slot === undefined ? undefined : parsed[slot]));
}

/** 面板上下内边距：整条色带，不写内容。 */
function bandBlankLine(width: number, bandStart: number): string {
	const start = Math.max(0, Math.min(bandStart, width));
	const lead = " ".repeat(start);
	return `${lead}${THEME.detailBg}${" ".repeat(Math.max(0, width - start))}${RESET}`;
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
		return `${lead}${THEME.detailBg}${paint}${visible}${padding}${RESET}`;
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
