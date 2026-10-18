import { eastAsianWidth } from "get-east-asian-width";

/**
 * 页脚输入框。
 *
 * 五行：运行时状态、上边框、输入行、下边框、常驻信息行；边框铺满整个终端宽度。运行时状态
 * 在有任务时显示加载符号与状态文字，空闲时留空；常驻信息行显示项目、分支、模型、思考强度、
 * 上下文与缓存命中率。光标交给终端自己画，下方输入区只算出实际显示哪一段以及光标应落在
 * 第几列。边框与提示符随焦点切换颜色，正文保持默认颜色。
 */

export interface InputView {
	/** 可见的提示符；窗口太窄时会被截断 */
	readonly prefix: string;
	/** 输入行实际显示的文字；超出宽度时只保留尾部 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
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

/** 运行时状态：加载符号、状态文字、阶段计时、总计时与 token 数。 */
export interface RuntimeStatus {
	readonly symbol: string;
	readonly text: string;
	readonly phaseMs?: number;
	readonly elapsedMs?: number;
	readonly tokens?: number;
	/** 扫光位置，0 到 1；省略时静态显示。 */
	readonly sweep?: number;
}

/** 扫光的底色、高光和半径（字符数）。 */
const SWEEP_BASE = 0x66;
const SWEEP_HIGHLIGHT = 0xff;
const SWEEP_RADIUS = 6;
/** 阶段计时、总计时与 token 数的静态颜色 #666666。 */
const STATUS_META_COLOR = "\x1b[38;2;102;102;102m";
/** 输入框下方常驻信息行的颜色 #242424。 */
const INFO_COLOR = "\x1b[38;2;36;36;36m";

/** 页脚固定五行：运行时状态、上边框、输入行、下边框、常驻信息行。 */
export const FOOTER_HEIGHT = 5;

/** 左侧留一列缩进，再放提示符，提示符与正文之间留一列。 */
const INPUT_PREFIX = " › ";
/** 获得焦点时边框与提示符的颜色 #e1e1e1。 */
const FOCUS_COLOR = "\x1b[38;2;225;225;225m";
/** 失去焦点时边框与提示符的颜色 #242424。 */
const BLUR_COLOR = "\x1b[38;2;36;36;36m";
const RESET = "\x1b[0m";

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
 * 最后一列留给终端光标，所以提示符加正文最多用 width-1 列；这样光标始终有地方停，输入
 * 再长也不会把整行挤出去。
 */
export function inputView(input: string, width: number): InputView {
	const available = Math.max(0, width - 1);
	const prefix = INPUT_PREFIX.slice(0, available);
	const prefixWidth = displayWidth(prefix);
	const tail = tailWithin(input, Math.max(0, available - prefixWidth));
	return {
		prefix,
		text: tail.text,
		column: Math.min(Math.max(1, width), prefixWidth + tail.width + 1),
	};
}

export function renderFooter(
	width: number,
	input: string,
	focused: boolean,
	status?: RuntimeStatus,
	info?: FooterInfo,
): readonly string[] {
	const columns = Math.max(0, width);
	const view = inputView(input, columns);
	return [
		statusLine(columns, status),
		colored(horizontal(columns), focused),
		colored(view.prefix, focused) + view.text,
		colored(horizontal(columns), focused),
		infoLine(columns, info),
	];
}

/**
 * 常驻信息行。
 *
 * 按「项目·分支 | 模型·思考强度 | 上下文 | 缓存命中率」分组；分支不存在时整段省略，
 * 上下文上限未声明时只写已用量。整行统一用暗色，避免和正文抢注意力。
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
	const text = truncateToWidth([location, model, context, cache].join(" | "), Math.max(0, width - 2));
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
	if (status.tokens !== undefined) rightParts.push(`⇣${formatTokens(status.tokens)}`);
	const right = rightParts.join("  ");

	let line: string;
	if (right.length === 0) {
		line = left.slice(0, statusWidth);
	} else if (left.length + right.length + 2 <= statusWidth) {
		line = left + " ".repeat(statusWidth - left.length - right.length) + right;
	} else {
		line = `${left}  ${right}`.slice(0, statusWidth);
	}

	// 扫光只覆盖活动描述；阶段计时、总计时和 token 保持静态的 #666666
	const visibleActivity = line.slice(0, Math.min(activity.length, line.length));
	const rest = line.slice(visibleActivity.length);
	const head = status.sweep === undefined ? visibleActivity : swept(visibleActivity, status.sweep);
	return head + (rest.length > 0 ? `${STATUS_META_COLOR}${rest}${RESET}` : "");
}

function swept(text: string, sweep: number): string {
	const center = -SWEEP_RADIUS + sweep * (text.length + SWEEP_RADIUS * 2);
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		const distance = Math.abs(index - center);
		const intensity = Math.max(0, 1 - distance / SWEEP_RADIUS);
		const value = Math.round(SWEEP_BASE + (SWEEP_HIGHLIGHT - SWEEP_BASE) * intensity);
		output += `\x1b[38;2;${value};${value};${value}m${text[index]}`;
	}
	return output + RESET;
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`;
}

function formatContext(used: number, total: number | undefined): string {
	const current = formatCompactTokens(used);
	return total === undefined ? current : `${current} / ${formatCompactTokens(total)}`;
}

/** 常驻信息行按 K/M 缩写，整数不带小数点：100K、1M。 */
function formatCompactTokens(tokens: number): string {
	const value = Math.max(0, tokens);
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
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

/** 从尾部往前留出不超过 limit 列，避免宽字符被切成半个。 */
function tailWithin(text: string, limit: number): { text: string; width: number } {
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;

	while (start > 0) {
		const char = chars[start - 1];
		const charWidth = eastAsianWidth(char.codePointAt(0) ?? 0);
		if (used + charWidth > limit) break;
		used += charWidth;
		start -= 1;
	}

	return { text: chars.slice(start).join(""), width: used };
}

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += eastAsianWidth(char.codePointAt(0) ?? 0);
	return width;
}

function horizontal(width: number): string {
	return "─".repeat(width);
}
