import { eastAsianWidth } from "get-east-asian-width";

/**
 * 页脚输入框。
 *
 * 四行：运行时状态、上边框、输入行、下边框；边框铺满整个终端宽度。状态行在有任务时显示
 * 加载符号与状态文字，空闲时留空。光标交给终端自己画，下方输入区只算出实际显示哪一段以及
 * 光标应落在第几列。边框与提示符随焦点切换颜色，正文保持默认颜色。
 */

export interface InputView {
	/** 可见的提示符；窗口太窄时会被截断 */
	readonly prefix: string;
	/** 输入行实际显示的文字；超出宽度时只保留尾部 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
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

/** 页脚固定四行：状态行、上边框、输入行、下边框。 */
export const FOOTER_HEIGHT = 4;

/** 左侧留一列缩进，再放提示符，提示符与正文之间留一列。 */
const INPUT_PREFIX = " › ";
/** 获得焦点时边框与提示符的颜色 #e1e1e1。 */
const FOCUS_COLOR = "\x1b[38;2;225;225;225m";
/** 失去焦点时边框与提示符的颜色 #242424。 */
const BLUR_COLOR = "\x1b[38;2;36;36;36m";
const RESET = "\x1b[0m";

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
): readonly string[] {
	const columns = Math.max(0, width);
	const view = inputView(input, columns);
	return [
		statusLine(columns, status),
		colored(horizontal(columns), focused),
		colored(view.prefix, focused) + view.text,
		colored(horizontal(columns), focused),
	];
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

	if (status.sweep === undefined || line.length === 0) return line;

	// 扫光只覆盖活动描述；阶段计时、总计时和 token 保持静态
	const visibleActivity = line.slice(0, Math.min(activity.length, line.length));
	return swept(visibleActivity, status.sweep) + line.slice(visibleActivity.length);
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
