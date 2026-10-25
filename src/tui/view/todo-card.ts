import { formatDuration } from "../../format.ts";
import { swept, type AnimationFrame } from "../render/sweep.ts";
import { displayWidth, fitToWidth, truncateToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 任务卡片：类型、参数解析与两种排版。
 *
 * 未收尾的列表只在常驻面板显示；全部完成或失败后整张卡落进对话流，面板随之清空。
 * 一次 todo 调用就是一张卡片，卡片自己不放状态——「当前列表」永远是会话里最后一次
 * 调用的参数，续聊与回填都靠会话重放。
 */

/** 任务条目的状态;failed 表示这一步无法完成，与完成、进行中、待办并列。 */
type TranscriptTodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TranscriptTodoItem {
	readonly content: string;
	readonly status: TranscriptTodoStatus;
}

/**
 * 任务卡片：一次 todo 调用的完整快照。
 *
 * 条目顺序保持模型给出的顺序——顺序本身就是执行顺序。running 由界面在回合结束时改回
 * false(与思考块同一先例):运行期间当前任务行是转圈加扫光，之后退为静态形态。
 * collapsed 是收起态，条目多时默认收起，双击头行切换。taskStartedAt 是当前进行中
 * 任务的起点，由界面在卡片创建时写入(同一任务在上一张卡片里也进行时继承起点),
 * 用于头行与折叠头行的耗时显示。
 */
export interface TranscriptTodo {
	readonly kind: "todo";
	/** 模型对这次更新的说明；当前排版不占行 */
	readonly explanation?: string;
	readonly items: readonly TranscriptTodoItem[];
	running?: boolean;
	collapsed?: boolean;
	taskStartedAt?: number;
}

/** 头行与条目的缩进：与对话流的回复正文、工具行保持同一列起头。 */
const CARD_INDENT = "  ";
/** 头行标记：与工具行的 › 同款，卡片与工具调用在同一列起头。 */
const CARD_MARKER = "›";
/** 任务卡头行的固定标签。 */
const TODO_HEADER_LABEL = "Tasks";
/** 条目超过这个数默认收起：短列表一眼全览，长列表只留状态行。 */
const TODO_EXPAND_MAX_ITEMS = 5;
/** 折叠头行里进行中任务名的显示宽度上限，超出省略。 */
const TODO_RUNNING_NAME_WIDTH = 30;
/** 任务条目比头行正文多缩进两列，条目标记正对头行标签的起头。 */
const TODO_ITEM_INDENT = `${CARD_INDENT}  `;
/** 加粗：进行中的任务行是全卡最亮的一项。 */
const BOLD = "\x1b[1m";
/** 任务卡头行标签：与子代理组头同一份强调青，计数弱一档。 */
const TODO_HEADER_COLOR = THEME.accent;
const TODO_COUNT_COLOR = THEME.textSecondary;
/** 待办条目：读得出但不抢注意力。 */
const TODO_PENDING_COLOR = THEME.textSecondary;
/** 进行中条目：强调色加粗，扫光也以它为高亮终点。 */
const TODO_ACTIVE_COLOR = THEME.accent;
/** 完成条目：圆点与标签同一份强调青，正文灰——与子代理清单同一份色板。 */
const TODO_DONE_COLOR = THEME.accent;
/** 失败条目：整行失败色,无删除线——失败在哪儿都是同一个符号同一份颜色。 */
const TODO_FAILED_COLOR = THEME.error;
/** 剩余条数行：弱化到背景里，不跟任务条目抢注意力。 */
const TODO_MORE_COLOR = THEME.textSubtle;

/** 任务表是否已经收尾：非空且没有待办、没有进行中。 */
export function todoCardFinished(card: TranscriptTodo): boolean {
	return (
		card.items.length > 0 &&
		card.items.every((item) => item.status === "completed" || item.status === "failed")
	);
}

/** 头行计数段：运行→完成→失败→待办，没有的段不显示。 */
function todoCountSegments(card: TranscriptTodo): string {
	let running = 0;
	let done = 0;
	let failed = 0;
	let pending = 0;
	for (const item of card.items) {
		if (item.status === "in_progress") running += 1;
		else if (item.status === "completed") done += 1;
		else if (item.status === "failed") failed += 1;
		else pending += 1;
	}

	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (done > 0) parts.push(`${done} done`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (pending > 0) parts.push(`${pending} pending`);
	return parts.join(" · ");
}

/**
 * 任务卡头行：标签 + 状态计数 + 耗时；折叠且运行中时在末尾带转圈任务名。
 *
 * 展开态把当前任务交给清单行，头行只回答全局进度；折叠态没有清单行，任务名才回到
 * 头行。窄屏时任务名先让步，计数与耗时最后才截断。
 */
function todoHeaderLine(card: TranscriptTodo, width: number, frame?: AnimationFrame): string {
	const label = `${CARD_INDENT}${CARD_MARKER} ${TODO_HEADER_LABEL}`;
	const counts = todoCountSegments(card);
	const running = card.items.find((item) => item.status === "in_progress");
	const isRunning = card.running === true && running !== undefined;
	const elapsed =
		isRunning && card.taskStartedAt !== undefined
			? ` (${formatDuration(Date.now() - card.taskStartedAt)})`
			: "";
	const baseText = counts.length === 0 ? "" : `  ${counts}${elapsed}`;
	const available = Math.max(0, width - displayWidth(label));
	const base = truncateToWidth(baseText, available);

	let namePart = "";
	let nameWidth = 0;
	if (card.collapsed === true && isRunning && frame !== undefined) {
		const budget = Math.max(
			0,
			available - displayWidth(base) - displayWidth(`  ${frame.spinner} `),
		);
		if (budget >= 2) {
			const name = fitToWidth(running.content, Math.min(TODO_RUNNING_NAME_WIDTH, budget));
			nameWidth = displayWidth(name);
			namePart = `  ${TODO_ACTIVE_COLOR}${BOLD}${frame.spinner} ${swept(name, frame.sweepPhase, THEME.accentDim, THEME.accentRgb)}`;
		}
	}

	const used = displayWidth(label) + displayWidth(base) + (nameWidth === 0 ? 0 : 2 + displayWidth(frame?.spinner ?? " ") + 1 + nameWidth);
	const padding = " ".repeat(Math.max(0, width - used));
	return `${TODO_HEADER_COLOR}${label}${THEME.reset}${TODO_COUNT_COLOR}${base}${THEME.reset}${namePart}${padding}`;
}

/**
 * 任务条目行：TaskN 标签与 SubagentN 同列，完成/待办标签青、正文灰，失败整行红，
 * 进行中整行青加粗；带帧时用转圈与扫光替换静态半圆。
 */
function todoItemLine(
	index: number,
	item: TranscriptTodoItem,
	width: number,
	frame?: AnimationFrame,
): string {
	const label = `Task${index + 1}`;
	const indent = TODO_ITEM_INDENT;
	const budget = Math.max(
		0,
		width - displayWidth(indent) - 2 - displayWidth(label) - 2,
	);
	const summary = truncateToWidth(item.content, budget);

	if (item.status === "completed") {
		return `${indent}${TODO_DONE_COLOR}● ${THEME.reset}${TODO_DONE_COLOR}${BOLD}${label}${THEME.reset}  ${TODO_PENDING_COLOR}${summary}${THEME.reset}`;
	}
	if (item.status === "failed") {
		return `${indent}${TODO_FAILED_COLOR}× ${label}  ${summary}${THEME.reset}`;
	}
	if (item.status === "pending") {
		return `${indent}${TODO_PENDING_COLOR}○ ${THEME.reset}${TODO_ACTIVE_COLOR}${BOLD}${label}${THEME.reset}  ${TODO_PENDING_COLOR}${summary}${THEME.reset}`;
	}
	if (frame !== undefined) {
		const visible = `${frame.spinner} ${label}  ${summary}`;
		return `${indent}${TODO_ACTIVE_COLOR}${BOLD}${swept(visible, frame.sweepPhase, THEME.accentDim, THEME.accentRgb)}`;
	}
	return `${indent}${TODO_ACTIVE_COLOR}${BOLD}◐ ${label}  ${summary}${THEME.reset}`;
}

/**
 * 从工具调用参数解析任务卡片。
 *
 * tool_start 在参数校验之前发出，参数可能形状不对：任何一处不合预期都返回 undefined,
 * 由调用方按普通工具行回退，让校验阶段的错误信息有行可挂。空白内容同样视为不合预期。
 * 收起默认值在这里定：实时与历史回填共用同一条规则。
 */
export function todoCardFromArgs(args: Record<string, unknown>): TranscriptTodo | undefined {
	const todos = args["todos"];
	if (!Array.isArray(todos)) return undefined;

	const items: TranscriptTodoItem[] = [];
	for (const entry of todos) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const content = (entry as Record<string, unknown>)["content"];
		const status = (entry as Record<string, unknown>)["status"];
		if (typeof content !== "string" || content.trim().length === 0) return undefined;
		if (
			status !== "pending" &&
			status !== "in_progress" &&
			status !== "completed" &&
			status !== "failed"
		) {
			return undefined;
		}
		items.push({ content, status });
	}

	const explanation = args["explanation"];
	if (explanation !== undefined && typeof explanation !== "string") return undefined;
	return {
		kind: "todo",
		...(explanation === undefined || explanation.trim().length === 0 ? {} : { explanation }),
		items,
		collapsed: items.length > TODO_EXPAND_MAX_ITEMS,
	};
}

/** 常驻面板最多显示的条目数:面板只回答「进行到哪」,条目再多也只列到上限。 */
export const TODO_PANEL_MAX_ITEMS = 8;

/**
 * 已经收尾的任务卡落到对话流里的屏幕行。
 *
 * 与面板共用同一套头行和 TaskN 条目排版，但不再动画：全部状态都已静止。条目多时
 * 默认收起（与面板同一条规则），双击头行展开。
 */
export function todoCardLines(card: TranscriptTodo, width: number): readonly string[] {
	const head = todoHeaderLine(card, width);
	if (card.collapsed === true) return [head];
	return [head, ...card.items.map((item, index) => todoItemLine(index, item, width))];
}

/**
 * 常驻面板的屏幕行：未收尾的任务卡唯一的显示位置。
 *
 * 头行 + 条目单行截断(不折行,面板不挤压对话流)。收起状态、运行标记与动画都由同一个
 * 卡对象决定；收尾后的卡片不再进面板。条目超上限时显示剩余数。
 */
export function todoPanelLines(
	card: TranscriptTodo,
	width: number,
	frame: AnimationFrame,
): readonly string[] {
	if (card.items.length === 0 || todoCardFinished(card)) return [];

	const head = todoHeaderLine(card, width, frame);
	if (card.collapsed === true) return [head];

	const itemFrame = card.running === true ? frame : undefined;
	const visible = card.items.slice(0, TODO_PANEL_MAX_ITEMS);
	const lines = [head, ...visible.map((item, index) => todoItemLine(index, item, width, itemFrame))];
	const hidden = card.items.length - visible.length;
	if (hidden > 0) {
		lines.push(`${TODO_ITEM_INDENT}${TODO_MORE_COLOR}… ${hidden} more${THEME.reset}`);
	}
	return lines;
}
