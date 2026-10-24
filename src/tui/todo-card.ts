import { formatDuration } from "../tools/format.ts";
import { swept } from "./sweep.ts";
import { displayWidth, fitToWidth, truncateToWidth, wrappedLines } from "./text.ts";
import { THEME } from "./theme.ts";

/**
 * 对话流里的任务卡片：类型、参数解析与排版。
 *
 * 一次 todo 调用就是一张卡片，卡片自己不放状态——「当前列表」永远是会话里最后一次调用
 * 的参数，续聊与回填都靠会话重放。这里只负责把参数变成屏幕行，以及运行期间按帧重建
 * 进行中条目的转圈与扫光。
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
 * false(与思考块同一先例):运行期间进行中的行是转圈加扫光，之后退为静态半圆。
 * collapsed 是收起态，条目多时默认收起，双击头行切换。taskStartedAt 是当前进行中
 * 任务的起点，由界面在卡片创建时写入(同一任务在上一张卡片里也进行时继承起点),
 * 只用于折叠头行的耗时显示。
 */
export interface TranscriptTodo {
	readonly kind: "todo";
	/** 模型对这次更新的说明；空白时不渲染 */
	readonly explanation?: string;
	readonly items: readonly TranscriptTodoItem[];
	running?: boolean;
	collapsed?: boolean;
	taskStartedAt?: number;
}

/** 渲染期重建动画行的原料：展开卡片的进行中条目行，或折叠卡片的头行。 */
export type LiveTodoLine =
	| { readonly kind: "item"; readonly indent: string; readonly content: string }
	| { readonly kind: "header"; readonly card: TranscriptTodo }
	| { readonly kind: "subagent"; readonly indent: string; readonly label: string; readonly summary: string };

/** 重建进行中任务行的当前帧：盲文运行符与扫光相位都由 100ms 刷新帧推进。 */
export interface TodoAnimationFrame {
	readonly spinner: string;
	readonly sweepPhase: number;
}

/** 头行与条目的缩进：与对话流的回复正文、工具行保持同一列起头。 */
const CARD_INDENT = "  ";
/** 头行标记：与工具行的 › 同款，卡片与工具调用在同一列起头。 */
const CARD_MARKER = "›";
/** 失败条目的标记：与错误行同用乘号 ×,失败在哪儿都是同一个符号。 */
const FAILED_MARKER = "×";
/** 任务卡头行的固定标签。 */
const TODO_HEADER_LABEL = "Tasks";
/** 条目超过这个数默认收起：短列表一眼全览，长列表只留状态行。 */
const TODO_EXPAND_MAX_ITEMS = 5;
/** 折叠头行里进行中任务名的显示宽度上限，超出省略。 */
const TODO_RUNNING_NAME_WIDTH = 30;
/** 任务条目比头行正文多缩进两列，条目标记正对头行标签的起头。 */
const TODO_ITEM_INDENT = `${CARD_INDENT}  `;
/** 删除线：完成与失败的任务靠它退场。 */
const STRIKETHROUGH = "\x1b[9m";
/** 斜体：任务卡说明行的强调方式。 */
const ITALIC = "\x1b[3m";
/** 加粗：进行中的任务行是全卡最亮的一项。 */
const BOLD = "\x1b[1m";
/** 任务卡头行标签：与工具组头同一档亮度，计数再弱一档。 */
const TODO_HEADER_COLOR = THEME.textSecondary;
const TODO_COUNT_COLOR = THEME.textSubtle;
/** 待办条目：读得出但不抢注意力。 */
const TODO_PENDING_COLOR = THEME.textSecondary;
/** 进行中条目：强调色加粗，扫光也以它为高亮终点。 */
const TODO_ACTIVE_COLOR = THEME.accent;
/** 完成条目：成功色配删除线，正反馈与退场感都要。 */
const TODO_DONE_COLOR = THEME.success;
/** 失败条目：与错误行同色，删除线只给符号与正文。 */
const TODO_FAILED_COLOR = THEME.error;
/** 说明行：弱化灰加斜体。 */
const TODO_EXPLANATION_COLOR = THEME.textSubtle;

/**
 * 任务卡片的屏幕行。
 *
 * 头行计数是「完成 / 总数」,空表写成 cleared。收起态只占头行一行；展开态渲染说明与
 * 全部条目。运行中的卡片把动画行(展开卡片的进行中条目、折叠卡片的头行)登记进
 * liveTodoLines,渲染期换转圈与扫光，这里一律先放静态行占位——两种形态行数一致，
 * 滚动与命中都不会因为换帧而错位。
 */
export function todoCardLines(
	card: TranscriptTodo,
	width: number,
	live: Map<number, LiveTodoLine>,
	start: number,
): readonly string[] {
	if (card.collapsed === true) {
		if (card.running === true && card.items.some((item) => item.status === "in_progress")) {
			live.set(start, { kind: "header", card });
		}
		return [todoHeaderLine(card, width)];
	}

	const lines: string[] = [todoHeaderLine(card, width)];

	const explanation = card.explanation?.trim() ?? "";
	if (explanation.length > 0) {
		lines.push(
			...wrappedLines(explanation, TODO_ITEM_INDENT, width, `${TODO_EXPLANATION_COLOR}${ITALIC}`),
		);
	}

	for (const item of card.items) {
		if (item.status === "pending") {
			lines.push(...wrappedLines(item.content, `${TODO_ITEM_INDENT}○ `, width, TODO_PENDING_COLOR));
			continue;
		}
		if (item.status === "completed") {
			lines.push(
				...wrappedLines(item.content, `${TODO_ITEM_INDENT}● `, width, `${TODO_DONE_COLOR}${STRIKETHROUGH}`),
			);
			continue;
		}
		if (item.status === "failed") {
			lines.push(
				...wrappedLines(item.content, `${TODO_ITEM_INDENT}${FAILED_MARKER} `, width, `${TODO_FAILED_COLOR}${STRIKETHROUGH}`),
			);
			continue;
		}

		// 进行中：静态占位行先入列,running 时再登记渲染期的动画原料
		const active = `${TODO_ACTIVE_COLOR}${BOLD}`;
		const staticLines = wrappedLines(item.content, `${TODO_ITEM_INDENT}◐ `, width, active);
		lines.push(...staticLines);
		if (card.running === true && staticLines[0] !== undefined) {
			const budget = Math.max(0, width - displayWidth(`${TODO_ITEM_INDENT}◐ `));
			live.set(start + lines.length - staticLines.length, {
				kind: "item",
				indent: TODO_ITEM_INDENT,
				content: truncateToWidth(item.content, budget),
			});
		}
	}

	return lines;
}

/** 任务卡头行：标签与计数同列于工具行，标签亮一档、计数弱一档。 */
function todoHeaderLine(card: TranscriptTodo, width: number): string {
	const done = card.items.filter((item) => item.status === "completed").length;
	const count = card.items.length === 0 ? "cleared" : `${done}/${card.items.length}`;
	const prefix = `${CARD_INDENT}${CARD_MARKER} `;
	const head = `${prefix}${TODO_HEADER_LABEL}`;
	const budget = Math.max(0, width - displayWidth(head));
	const tail = truncateToWidth(`  ${count}`, budget);
	const padding = " ".repeat(Math.max(0, budget - displayWidth(tail)));
	return `${TODO_HEADER_COLOR}${head}${THEME.reset}${TODO_COUNT_COLOR}${tail}${THEME.reset}${padding}`;
}

/** 渲染期按当前帧重建动画行：展开卡片是条目行，折叠卡片是头行，子代理清单是运行行。 */
export function animatedTodoLine(live: LiveTodoLine, frame: TodoAnimationFrame, width: number): string {
	if (live.kind === "header") return animatedTodoHeader(live.card, frame, width);
	if (live.kind === "subagent") {
		return animatedSubagentLine(live.indent, live.label, live.summary, frame, width);
	}
	return animatedRunningLine(live.indent, live.content, frame, width);
}

/**
 * 任务卡片运行中条目的动画行:盲文运行符 + 扫光正文。
 */
function animatedRunningLine(
	indent: string,
	content: string,
	frame: TodoAnimationFrame,
	width: number,
): string {
	const budget = Math.max(0, width - displayWidth(`${indent}◐ `));
	const visible = truncateToWidth(content, budget);
	const head = `${indent}${THEME.accent}${BOLD}${frame.spinner} `;
	const body = swept(visible, frame.sweepPhase, THEME.accentDim, THEME.accentRgb);
	const padding = " ".repeat(Math.max(0, budget - displayWidth(visible)));
	return `${head}${body}${padding}`;
}

/**
 * 子代理清单运行行的动画行:转圈与标签青色加粗(扫光只扫标签),摘要保持灰。
 */
function animatedSubagentLine(
	indent: string,
	label: string,
	summary: string,
	frame: TodoAnimationFrame,
	width: number,
): string {
	const budget = Math.max(0, width - displayWidth(indent) - 2);
	const labelPart = truncateToWidth(label, budget);
	const summaryPart = truncateToWidth(summary, Math.max(0, budget - displayWidth(labelPart) - 2));
	const head = `${indent}${THEME.accent}${BOLD}${frame.spinner} ${swept(labelPart, frame.sweepPhase, THEME.accentDim, THEME.accentRgb)}`;
	const padding = " ".repeat(
		Math.max(0, budget - displayWidth(labelPart) - displayWidth(summaryPart)),
	);
	return `${head}  ${THEME.textSecondary}${summaryPart}${THEME.reset}${padding}`;
}

/**
 * 折叠头行的运行期形态：计数 + 转圈运行符 + 扫光任务名 + 耗时。
 *
 * 窄屏按「计数 → 任务名 → 耗时」的优先级舍弃：计数说明全局进度，任务名说明此刻在
 * 干什么，耗时最有富余，放不下时先丢。任务名另受 TODO_RUNNING_NAME_WIDTH 的固定
 * 上限约束，超长省略。
 */
function animatedTodoHeader(card: TranscriptTodo, frame: TodoAnimationFrame, width: number): string {
	const done = card.items.filter((item) => item.status === "completed").length;
	const label = `${CARD_INDENT}${CARD_MARKER} ${TODO_HEADER_LABEL}`;
	const countPart = `  ${done}/${card.items.length}`;

	const elapsed =
		card.taskStartedAt === undefined ? "" : formatDuration(Date.now() - card.taskStartedAt);
	const elapsedPart = elapsed.length === 0 ? "" : `  ${elapsed}`;

	const running = card.items.find((item) => item.status === "in_progress");
	let name = "";
	let nameWidth = 0;
	if (running !== undefined) {
		const budget = Math.max(
			0,
			width - displayWidth(label) - displayWidth(countPart) - displayWidth(elapsedPart) - displayWidth(`  ${frame.spinner} `),
		);
		if (budget >= 2) {
			name = fitToWidth(running.content, Math.min(TODO_RUNNING_NAME_WIDTH, budget));
			nameWidth = displayWidth(name);
		}
	}

	const namePart =
		name.length === 0
			? ""
			: `  ${TODO_ACTIVE_COLOR}${BOLD}${frame.spinner} ${swept(name, frame.sweepPhase, THEME.accentDim, THEME.accentRgb)}`;
	const padding = " ".repeat(
		Math.max(
			0,
			width -
				displayWidth(label) -
				displayWidth(countPart) -
				(displayWidth(`  ${frame.spinner} `) + nameWidth) -
				displayWidth(elapsedPart),
		),
	);
	return `${TODO_HEADER_COLOR}${label}${THEME.reset}${TODO_COUNT_COLOR}${countPart}${THEME.reset}${namePart}${TODO_COUNT_COLOR}${elapsedPart}${THEME.reset}${padding}`;
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
