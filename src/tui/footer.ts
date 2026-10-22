import { eastAsianWidth } from "get-east-asian-width";

import { THEME } from "./theme.ts";

/**
 * 页脚输入框。
 *
 * 默认六行：空白间隔、运行时状态、上边框、输入行、下边框、常驻信息行；边框铺满整个终端宽度。
 * 模型面板打开时改用紧凑四行，去掉空白与状态行，让面板直接接在输入框上方。空白间隔把对话流
 * 和运行时状态行分开，正文滚到底时不会贴在一起。运行时状态在有任务时显示加载符号与状态文字，
 * 空闲时留空；常驻信息行显示项目、分支、模型、思考强度、上下文与缓存命中率。光标交给终端自己
 * 画，下方输入区只算出实际显示哪一段以及光标应落在第几列。边框与提示符随焦点切换颜色，正文
 * 保持默认颜色。
 */

export interface InputLine {
	readonly prefix: string;
	readonly text: string;
	/** text 开头属于命令的字符数；0 表示这一行没有命令 */
	readonly commandEnd?: number;
}

export interface InputView {
	/** 可见的提示符；窗口太窄时会被截断 */
	readonly prefix: string;
	/** 光标所在输入行的可见文字 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
	/** 可见的输入行（多行粘贴时可能多于一行） */
	readonly lines: readonly InputLine[];
	/** 光标在 lines 里的下标 */
	readonly row: number;
}

/** 输入框下方那一行常驻信息。 */
export interface FooterInfo {
	readonly project: string;
	/** 不是 git 仓库时为空，这一项整段不显示 */
	readonly branch: string | undefined;
	readonly model: string;
	readonly effort: string;
	/** 当前上下文的 token 数 */
	readonly contextUsed: number;
	/** 上下文上限；未声明时只显示已用量 */
	readonly contextWindow: number | undefined;
	/** 缓存读取占输入侧 token 的比例，0 到 1 */
	readonly cacheHitRate: number;
}

/** 运行时状态：加载符号、状态文字、阶段计时、总计时与本轮 token 已用。 */
export interface RuntimeStatus {
	readonly symbol: string;
	readonly text: string;
	readonly phaseMs?: number;
	readonly elapsedMs?: number;
	/** 本轮请求累计消耗的 token 数；压缩请求不计入 */
	readonly tokens?: number;
	/** 扫光位置，0 到 1；省略时静态显示。 */
	readonly sweep?: number;
	/**
	 * 色调。默认是「正在进行」的强调色 + 扫光；warning 表示遇挫但还在继续（重试），
	 * error 表示这一轮已经失败，stopped 表示使用者主动停下——后两者都是静止状态。
	 */
	readonly tone?: "warning" | "error" | "stopped";
}

/** 扫光从强调色暗部过渡到白色。 */
const SWEEP_BASE = THEME.accentDim;
const SWEEP_HIGHLIGHT = 0xff;
const SWEEP_RADIUS = 6;
/** 阶段计时、总计时与 token 数的静态颜色。 */
const STATUS_META_COLOR = THEME.textSubtle;
/** 输入框下方常驻信息行的颜色。 */
const INFO_COLOR = THEME.textSecondary;
/** 运行时状态文字与焦点边框的强调色。 */
const ACCENT_COLOR = THEME.accent;
/** 结局是失败时状态文字用它。 */
const ERROR_COLOR = THEME.error;
const WARNING_COLOR = THEME.warning;
/** 主动停下的状态文字：中性弱化色，既不像错误那样刺眼，也不像进行中那样吸引注意。 */
const STOPPED_COLOR = THEME.textSubtle;

/** 页脚固定六行：空白间隔、运行时状态、上边框、输入行、下边框、常驻信息行。 */
export const FOOTER_HEIGHT = 6;

/** 菜单打开时的紧凑页脚：上边框、输入行、下边框、常驻信息行。 */
export const COMPACT_FOOTER_HEIGHT = 4;

/**
 * 排队预览占几行。
 *
 * 行数只由这里决定：绘制、页脚高度与光标定位必须用同一个数，否则输入框会整体错位。
 * 空队列不占行。
 */
export function queueHeight(count: number): number {
	if (count <= 0) return 0;
	return Math.min(count, QUEUE_MAX_VISIBLE) + (count > QUEUE_MAX_VISIBLE ? 1 : 0);
}

/** 页脚布局开关；默认是完整的六行。 */
export interface FooterLayout {
	/** 状态行上方是否留一行与对话流分隔；菜单面板已经承担分隔时可以关掉 */
	readonly leadingGap?: boolean;
	/** 是否显示运行时状态行 */
	readonly showStatus?: boolean;
	/** 输入光标位置；省略时停在末尾 */
	readonly cursor?: number;
	/** 输入开头命中的命令占多少字符（含斜杠）；0 或不给表示没有命中 */
	readonly commandLength?: number;
	/** 排队中的消息，按发送顺序；只在完整页脚里显示 */
	readonly queued?: readonly string[];
}

/** 多行输入最多同时显示几行，再多就围绕光标滚动。 */
export const MAX_VISIBLE_INPUT_LINES = 6;

/** 左侧留一列缩进，再放提示符，提示符与正文之间留一列。 */
const INPUT_PREFIX = " › ";
/** 排队消息的缩进与标记，列宽与输入提示符一致，两处文字对齐。 */
const QUEUE_PREFIX = " ↳ ";
/** 排队预览最多显示几条；更多的收成一行计数。 */
const QUEUE_MAX_VISIBLE = 3;
/** 排队消息比正文弱一档：它还没发生，不该跟正在进行的对话抢注意力。 */
const QUEUE_COLOR = THEME.textSubtle;
/** 多行输入的续行缩进，与首行正文对齐。 */
const INPUT_CONTINUATION = "   ";
/** 获得焦点时边框与提示符使用强调色。 */
const FOCUS_COLOR = THEME.accent;
/** 失去焦点时边框与提示符使用边框色。 */
const BLUR_COLOR = THEME.border;
const RESET = THEME.reset;

/** 常驻信息行每一项前的图标。 */
const PROJECT_ICON = "📁";
const BRANCH_ICON = "🌿";
const MODEL_ICON = "🤖";
const EFFORT_ICON = "🧠";
const CONTEXT_ICON = "📊";
const CACHE_ICON = "⚡";

/**
 * 输入行的可见部分与光标列。
 *
 * 支持显式换行：多行粘贴后每行单独显示，最多同时显示 MAX_VISIBLE_INPUT_LINES 行，围绕
 * 光标滚动。光标所在行会横向滚动，保证光标始终可见。
 */
export function inputView(
	input: string,
	width: number,
	cursor = input.length,
	commandLength = 0,
): InputView {
	const columns = Math.max(0, width);
	const logical = input.split("\n");
	const cursorAt = Math.min(Math.max(0, cursor), input.length);

	let lineIndex = 0;
	let offset = cursorAt;
	while (lineIndex < logical.length - 1 && offset > (logical[lineIndex]?.length ?? 0)) {
		offset -= (logical[lineIndex]?.length ?? 0) + 1;
		lineIndex += 1;
	}
	offset = Math.min(offset, logical[lineIndex]?.length ?? 0);

	const start = Math.max(0, Math.min(lineIndex, logical.length - 1) - (MAX_VISIBLE_INPUT_LINES - 1));
	const visible = logical.slice(start, start + MAX_VISIBLE_INPUT_LINES);

	let cursorLine: InputLine = { prefix: "", text: "" };
	let cursorWidth = 0;
	let cursorPrefixWidth = 0;

	const lines = visible.map((text, index) => {
		const logicalIndex = start + index;
		const prefix = truncateToWidth(
			logicalIndex === 0 ? INPUT_PREFIX : INPUT_CONTINUATION,
			Math.max(0, columns - 1),
		);
		const prefixWidth = displayWidth(prefix);
		const textWidth = Math.max(0, columns - prefixWidth - 1);
		// 命令只可能在输入的第一行开头，且不含换行
		const commandChars = logicalIndex === 0 ? Math.min(commandLength, Array.from(text).length) : 0;

		if (logicalIndex !== lineIndex) {
			const shown = truncateToWidth(text, textWidth);
			return { prefix, text: shown, commandEnd: Math.min(commandChars, Array.from(shown).length) };
		}

		const window = lineWindow(text, offset, textWidth);
		cursorLine = { prefix, text: window.text };
		cursorWidth = window.cursorWidth;
		cursorPrefixWidth = prefixWidth;
		return {
			...cursorLine,
			commandEnd: Math.max(0, Math.min(commandChars - window.start, Array.from(window.text).length)),
		};
	});

	return {
		prefix: cursorLine.prefix,
		text: cursorLine.text,
		column: Math.min(Math.max(1, columns), cursorPrefixWidth + cursorWidth + 1),
		lines,
		row: lineIndex - start,
	};
}

/** 光标所在行的横向窗口：先保证光标之前的文字尽量完整，再向右填满。 */
function lineWindow(
	text: string,
	cursorOffset: number,
	width: number,
): { readonly text: string; readonly cursorWidth: number; readonly start: number } {
	const chars = Array.from(text);
	const cursorChars = Array.from(text.slice(0, cursorOffset)).length;
	const widths = chars.map((char) => characterWidth(char));
	const total = widths.reduce((sum, item) => sum + item, 0);
	const cursorTotal = widths.slice(0, cursorChars).reduce((sum, item) => sum + item, 0);

	if (total <= width) return { text, cursorWidth: cursorTotal, start: 0 };

	let start = 0;
	if (cursorTotal > width) {
		let used = 0;
		start = cursorChars;
		while (start > 0) {
			const charWidth = widths[start - 1] ?? 0;
			if (used + charWidth > width) break;
			used += charWidth;
			start -= 1;
		}
	}

	let used = 0;
	let end = start;
	while (end < chars.length) {
		const charWidth = widths[end] ?? 0;
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	const visibleCursor = widths
		.slice(start, cursorChars)
		.reduce((sum, item) => sum + item, 0);
	return { text: chars.slice(start, end).join(""), cursorWidth: visibleCursor, start };
}

export function renderFooter(
	width: number,
	input: string,
	focused: boolean,
	status?: RuntimeStatus,
	info?: FooterInfo,
	layout?: FooterLayout,
): readonly string[] {
	const columns = Math.max(0, width);
	const view = inputView(input, columns, layout?.cursor, layout?.commandLength ?? 0);
	const lines: string[] = [];
	if (layout?.leadingGap !== false) lines.push("");
	if (layout?.showStatus !== false) {
		lines.push(statusLine(columns, status));
		// 排队预览与状态行描述的是同一件事：正在跑的回合之外还等着什么。紧凑页脚把这块
		// 面积让给菜单面板，两者一起收起。
		lines.push(...queueLines(columns, layout?.queued ?? []));
	}
	lines.push(colored(horizontal(columns), focused));
	for (const line of view.lines) {
		lines.push(colored(line.prefix, focused) + commandText(line));
	}
	lines.push(colored(horizontal(columns), focused), infoLine(columns, info));
	return lines;
}

/**
 * 排队消息的预览行。
 *
 * 每条只占一行：排队的是「稍后要说什么」，看个开头就够；整条铺开会把正在跑的回复挤出视野。
 * 超出上限的部分收成一行计数，让人知道还有几条在后面。
 */
function queueLines(width: number, queued: readonly string[]): readonly string[] {
	if (queued.length === 0) return [];

	const prefixWidth = displayWidth(QUEUE_PREFIX);
	const textWidth = Math.max(1, width - prefixWidth - 1);
	const lines = queued
		.slice(0, QUEUE_MAX_VISIBLE)
		.map((text) => `${QUEUE_COLOR}${QUEUE_PREFIX}${truncateToWidth(oneLine(text), textWidth)}${RESET}`);
	const hidden = queued.length - QUEUE_MAX_VISIBLE;
	if (hidden > 0) {
		lines.push(`${QUEUE_COLOR}${" ".repeat(prefixWidth)}+${hidden} more${RESET}`);
	}
	return lines;
}

/** 换行与制表符会把一条消息撑成多行，预览里一律压成单行。 */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * 输入行正文：命中的命令用强调色，参数与其它文字保持正文色。
 *
 * 只换颜色不改宽度，光标列与横向滚动的计算不受影响。
 */
function commandText(line: InputLine): string {
	const end = line.commandEnd ?? 0;
	if (end <= 0) return line.text;
	const chars = Array.from(line.text);
	if (end >= chars.length) return `${FOCUS_COLOR}${line.text}${RESET}`;
	return `${FOCUS_COLOR}${chars.slice(0, end).join("")}${RESET}${chars.slice(end).join("")}`;
}

/**
 * 常驻信息行。
 *
 * 按「项目·分支 | 模型·思考强度 | 上下文 | 缓存命中率」分组；分支不存在时整段省略，
 * 上下文上限未声明时只写已用量。整行统一用暗色，避免和正文抢注意力。
 *
 * 终端变窄时按优先级整项舍弃，而不是从右侧硬截：先丢缓存，再丢项目位置，再丢模型，
 * 最后只保留上下文并截断。上下文是判断何时该压缩的依据，让它最先消失最不划算。
 */
function infoLine(width: number, info: FooterInfo | undefined): string {
	if (info === undefined) return "";

	const location =
		info.branch === undefined
			? `${PROJECT_ICON} ${info.project}`
			: `${PROJECT_ICON} ${info.project} · ${BRANCH_ICON} ${info.branch}`;
	const model = `${MODEL_ICON} ${info.model} · ${EFFORT_ICON} ${info.effort}`;
	const context = `${CONTEXT_ICON} ${formatContext(info.contextUsed, info.contextWindow)}`;
	const cache = `${CACHE_ICON} ${Math.round(info.cacheHitRate * 100)}%`;
	// 与运行时状态行一样避开最右侧两列，两行文字在同一条竖线上收尾
	const available = Math.max(0, width - 2);

	for (const parts of [
		[location, model, context, cache],
		[location, model, context],
		[model, context],
		[context],
	]) {
		const text = parts.join(" | ");
		if (displayWidth(text) <= available) return `${INFO_COLOR}${text}${RESET}`;
	}

	const text = truncateToWidth(context, available).trimEnd();
	if (text.length === 0) return "";
	return `${INFO_COLOR}${text}${RESET}`;
}

function statusLine(width: number, status: RuntimeStatus | undefined): string {
	if (status === undefined) return "";

	// 状态行和对话流一样避开最右侧两列：一列间距加一列滚动条
	const statusWidth = Math.max(0, width - 2);
	const activity = ` ${status.symbol} ${status.text}`;
	const phase = status.phaseMs === undefined ? "" : formatDuration(status.phaseMs);
	const left = phase.length > 0 ? `${activity}  ${phase}` : activity;

	const rightParts: string[] = [];
	if (status.elapsedMs !== undefined) rightParts.push(formatDuration(status.elapsedMs));
	if (status.tokens !== undefined) rightParts.push(`⇣${formatCompactTokens(status.tokens)}`);
	const right = rightParts.join("  ");

	let line: string;
	if (right.length === 0) {
		line = left.slice(0, statusWidth);
	} else if (left.length + right.length + 2 <= statusWidth) {
		line = left + " ".repeat(statusWidth - left.length - right.length) + right;
	} else {
		line = `${left}  ${right}`.slice(0, statusWidth);
	}

	// 扫光只覆盖活动描述；阶段计时、总计时和 token 保持静态的 #6b7580
	const visibleActivity = line.slice(0, Math.min(activity.length, line.length));
	const rest = line.slice(visibleActivity.length);
	const toneColor =
		status.tone === "error" ? ERROR_COLOR : status.tone === "warning" ? WARNING_COLOR : STOPPED_COLOR;
	const head =
		status.tone !== undefined
			? `${toneColor}${visibleActivity}${RESET}`
			: status.sweep === undefined
				? `${ACCENT_COLOR}${visibleActivity}${RESET}`
				: swept(visibleActivity, status.sweep);
	return head + (rest.length > 0 ? `${STATUS_META_COLOR}${rest}${RESET}` : "");
}

function swept(text: string, sweep: number): string {
	const center = -SWEEP_RADIUS + sweep * (text.length + SWEEP_RADIUS * 2);
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		const distance = Math.abs(index - center);
		const intensity = Math.max(0, 1 - distance / SWEEP_RADIUS);
		const r = Math.round(SWEEP_BASE.r + (SWEEP_HIGHLIGHT - SWEEP_BASE.r) * intensity);
		const g = Math.round(SWEEP_BASE.g + (SWEEP_HIGHLIGHT - SWEEP_BASE.g) * intensity);
		const b = Math.round(SWEEP_BASE.b + (SWEEP_HIGHLIGHT - SWEEP_BASE.b) * intensity);
		output += `\x1b[38;2;${r};${g};${b}m${text[index]}`;
	}
	return output + RESET;
}

/** 耗时不足一分钟保留一位小数秒；满一分钟后写成「1m」，有零头才带秒，如「1m1s」。 */
function formatDuration(ms: number): string {
	const tenths = Math.round(Math.max(0, ms) / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const seconds = Math.round(tenths / 10);
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

function formatContext(used: number, total: number | undefined): string {
	const current = formatCompactTokens(used);
	return total === undefined ? current : `${current} / ${formatCompactTokens(total)}`;
}

/**
 * 常驻信息行与运行时状态共用同一套缩写。
 *
 * 100 以下保留整数；100 到 999 也进入 K，向下取整到一位小数，例如 999 → 0.9K；
 * 1000 以上四舍五入到一位小数；接近一百万的 K 值会进位成 M，不出现 1000K。
 */
function formatCompactTokens(tokens: number): string {
	const value = Math.max(0, tokens);
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (value >= 1_000) {
		const thousands = Math.round((value / 1_000) * 10) / 10;
		if (thousands >= 1_000) return `${trimDecimal(thousands / 1_000)}M`;
		return `${trimDecimal(thousands)}K`;
	}
	if (value >= 100) return `${Math.floor(value / 100) / 10}K`;
	return `${Math.round(value)}`;
}

function trimDecimal(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/** 按显示宽度截断，宽字符与 emoji 不会被切成半个。 */
function truncateToWidth(text: string, width: number): string {
	const chars = Array.from(text);
	let used = 0;
	let end = 0;

	while (end < chars.length) {
		const charWidth = eastAsianWidth(chars[end].codePointAt(0) ?? 0);
		if (used + charWidth > width) break;
		used += charWidth;
		end += 1;
	}

	return chars.slice(0, end).join("");
}

function colored(text: string, focused: boolean): string {
	return `${focused ? FOCUS_COLOR : BLUR_COLOR}${text}${RESET}`;
}

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += characterWidth(char);
	return width;
}

function characterWidth(char: string): number {
	return eastAsianWidth(char.codePointAt(0) ?? 0);
}

function horizontal(width: number): string {
	return "─".repeat(width);
}
