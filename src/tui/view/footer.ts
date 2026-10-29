import type { ApprovalMode } from "../../config/file.ts";
import { formatCompactTokens, formatDuration } from "../../shared/format.ts";
import { highlightImageMarkers } from "../image.ts";
import { swept } from "../render/sweep.ts";
import { characterWidth, displayWidth, graphemes, truncateToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 页脚输入框。
 *
 * 默认六行：空白间隔、运行时状态、上边框、输入行、下边框、常驻信息行；边框铺满整个终端宽度。
 * 模型面板打开时改用紧凑四行，去掉空白与状态行，让面板直接接在输入框上方。空白间隔把对话流
 * 和运行时状态行分开，正文滚到底时不会贴在一起。运行时状态在有任务时显示加载符号与状态文字，
 * 空闲时留空；常驻信息行左侧显示项目、分支、模型、思考强度、上下文与缓存命中率，行尾固定显示
 * 审批方式徽标（Shift+Tab 切换）。光标交给终端自己画，下方输入区只算出实际显示哪一段以及光标
 * 应落在第几列。边框与提示符随焦点切换颜色，正文保持默认颜色。
 */

interface InputLine {
	readonly prefix: string;
	readonly text: string;
	/** text 开头属于命令的字符数；0 表示这一行没有命令 */
	readonly commandEnd?: number;
}

interface InputView {
	/** 可见的提示符；窗口太窄时会被截断 */
	readonly prefix: string;
	/** 光标所在输入行的可见文字 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
	/** 可见的输入行：显式换行与软换行都会增加行数 */
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
	/**
	 * 当前审批方式；在行尾固定显示 ASK/AUTO/YOLO 徽标。
	 *
	 * 省略时不画徽标——配置读不出来时没有可信的审批方式，显示任何一档都会误导。
	 */
	readonly approval?: ApprovalMode;
	/** 是否处于 Plan 模式；为 true 时在审批徽标左侧再画一个 PLAN */
	readonly planMode?: boolean;
}

/** 运行时状态：加载符号、状态文字、阶段计时、总计时与本轮 token 已用。 */
interface RuntimeStatus {
	readonly symbol: string;
	readonly text: string;
	readonly phaseMs?: number;
	readonly elapsedMs?: number;
	/** 本轮请求累计消耗的 token 数；压缩请求不计入 */
	readonly tokens?: number;
	/** token 位置要显示的文字；有值时优先于 tokens，用于复制成功这类瞬时提示 */
	readonly tokenLabel?: string;
	/** 扫光位置，0 到 1；省略时静态显示。 */
	readonly sweep?: number;
	/**
	 * 色调。默认是「正在进行」的强调色 + 扫光；warning 表示遇挫但还在继续（重试），
	 * error 表示这一轮已经失败，notice 表示配置缺失这类阻断或提示——后两者都是静止状态。
	 */
	readonly tone?: "warning" | "error" | "notice";
}

/** 扫光从强调色暗部过渡到白色。 */
const SWEEP_BASE = THEME.accentDim;
const SWEEP_HIGHLIGHT = THEME.sweepHighlight;
/** 阶段计时、总计时与 token 数的静态颜色。 */
const STATUS_META_COLOR = THEME.textSubtle;
/** 输入框下方常驻信息行的颜色。 */
const INFO_COLOR = THEME.textSecondary;
/** 运行时状态文字与焦点边框的强调色。 */
const ACCENT_COLOR = THEME.accent;
/** 结局是失败时状态文字用它。 */
const ERROR_COLOR = THEME.error;
const WARNING_COLOR = THEME.warning;
/** 阻断与提示的状态文字：中性色，不跟着转圈，也不像错误那样刺眼。 */
const NOTICE_COLOR = THEME.textSecondary;

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
interface FooterLayout {
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

/** 输入最多同时显示几行（显式换行与软换行都算），再多就围绕光标滚动。 */
const MAX_VISIBLE_INPUT_LINES = 6;

/** 左侧留一列缩进，再放提示符，提示符与正文之间留一列。 */
const INPUT_PREFIX = " › ";
/** 排队消息的缩进与标记，列宽与输入提示符一致，两处文字对齐。 */
const QUEUE_PREFIX = " ↳ ";
/** 排队预览最多显示几条；更多的收成一行计数。 */
export const QUEUE_MAX_VISIBLE = 3;
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
 * 支持两种换行：显式换行（Alt+Enter、多行粘贴）按 \n 分行；单个逻辑行超过可用宽度时按
 * 显示宽度软换行，字素簇（宽字符、组合序列、emoji）不会被切到两行。最多同时显示
 * MAX_VISIBLE_INPUT_LINES 行，围绕光标滚动，光标始终落在可见区内。
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

	const lines: InputLine[] = [];
	let cursorLine: InputLine = { prefix: "", text: "" };
	let cursorRow = 0;
	let cursorWidth = 0;
	let cursorPrefixWidth = 0;

	// 提示符与续行缩进等宽，正文可用宽度只需算一次；窄到放不下提示符时正文宽度为 0
	const textWidth = Math.max(0, columns - displayWidth(INPUT_CONTINUATION) - 1);

	for (let index = 0; index < logical.length; index += 1) {
		const text = logical[index] ?? "";
		const segments = wrapLine(text, textWidth);
		const cursorSegment = index === lineIndex ? segmentAt(segments, offset) : -1;

		for (let part = 0; part < segments.length; part += 1) {
			const segment = segments[part] as InputLineSegment;
			// 整个输入的第一个可见行带提示符；显式换行与软换行的续行都用等宽缩进，正文对齐
			const prefix = truncateToWidth(
				lines.length === 0 ? INPUT_PREFIX : INPUT_CONTINUATION,
				Math.max(0, columns - 1),
			);
			const prefixWidth = displayWidth(prefix);
			// 段已经按宽度切好，再截一次只为兜住「单个字素比整行还宽」：放不下的字符只能不显示，
			// 让它溢出会让终端自己折行，后续每一行的坐标都会错位
			const shown = truncateToWidth(text.slice(segment.start, segment.end), textWidth);
			// 命令只可能出现在整个输入的开头；软换行后它可能跨几行，每行各自高亮自己那段
			const commandEnd =
				index === 0
					? Math.max(0, Math.min(commandLength, segment.endChar) - segment.startChar)
					: 0;
			const line: InputLine = { prefix, text: shown, commandEnd };
			if (part === cursorSegment) {
				cursorLine = line;
				cursorRow = lines.length;
				cursorPrefixWidth = prefixWidth;
				cursorWidth = textWidth <= 0 ? 0 : displayWidth(text.slice(segment.start, offset));
			}
			lines.push(line);
		}
	}

	const start = Math.max(0, cursorRow - (MAX_VISIBLE_INPUT_LINES - 1));
	return {
		prefix: cursorLine.prefix,
		text: cursorLine.text,
		column: Math.min(Math.max(1, columns), cursorPrefixWidth + cursorWidth + 1),
		lines: lines.slice(start, start + MAX_VISIBLE_INPUT_LINES),
		row: cursorRow - start,
	};
}

/** 软换行后的一段：start/end 是原行内的 UTF-16 偏移，startChar/endChar 是字素下标。 */
interface InputLineSegment {
	readonly start: number;
	readonly end: number;
	readonly startChar: number;
	readonly endChar: number;
}

/**
 * 把一个逻辑行按显示宽度切成若干段。
 *
 * 段边界只落在字素簇之间：宽字符、组合序列与 emoji 被劈开会在终端里错位。单个字素本身
 * 比整行还宽时也让它独占一段，否则原地反复切不开。
 */
function wrapLine(text: string, limit: number): readonly InputLineSegment[] {
	const chars = graphemes(text);
	if (limit <= 0 || chars.length === 0) {
		return [{ start: 0, end: text.length, startChar: 0, endChar: chars.length }];
	}

	const segments: InputLineSegment[] = [];
	let start = 0;
	let startChar = 0;
	let used = 0;
	let unit = 0;

	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index] ?? "";
		const charWidth = characterWidth(char);
		if (used + charWidth > limit && index > startChar) {
			segments.push({ start, end: unit, startChar, endChar: index });
			start = unit;
			startChar = index;
			used = 0;
		}
		used += charWidth;
		unit += char.length;
	}

	segments.push({ start, end: text.length, startChar, endChar: chars.length });
	return segments;
}

/** 光标偏移落在哪一段；偏移正好在段边界上时归下一段，光标显示在下一行行首。 */
function segmentAt(segments: readonly InputLineSegment[], offset: number): number {
	let found = 0;
	for (let index = 0; index < segments.length; index += 1) {
		if ((segments[index] as InputLineSegment).start <= offset) found = index;
		else break;
	}
	return found;
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
	const frame = frameColor(focused, info?.approval);
	if (layout?.leadingGap !== false) lines.push("");
	if (layout?.showStatus !== false) {
		lines.push(statusLine(columns, status));
		// 排队预览与状态行描述的是同一件事：正在跑的回合之外还等着什么。紧凑页脚把这块
		// 面积让给菜单面板，两者一起收起。
		lines.push(...queueLines(columns, layout?.queued ?? []));
	}
	lines.push(colored(horizontal(columns), frame));
	for (const line of view.lines) {
		lines.push(colored(line.prefix, frame) + commandText(line, frame));
	}
	lines.push(colored(horizontal(columns), frame), infoLine(columns, info));
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
function commandText(line: InputLine, color: string): string {
	const end = line.commandEnd ?? 0;
	if (end <= 0) return highlightImageMarkers(line.text, THEME.image, RESET);
	const chars = graphemes(line.text);
	if (end >= chars.length) return `${color}${line.text}${RESET}`;
	const rest = chars.slice(end).join("");
	return `${color}${chars.slice(0, end).join("")}${RESET}${highlightImageMarkers(rest, THEME.image, RESET)}`;
}

/** 审批徽标的配色按风险分级：逐次询问是安全默认，自动审查是「谨慎放行」，完全放行最刺眼。 */
const APPROVAL_BADGE_COLORS: Readonly<Record<ApprovalMode, string>> = {
	ask: THEME.accent,
	auto: THEME.warning,
	yolo: THEME.error,
};
/** Plan 是工作方式而不是权限档位，用路径蓝与审批徽标分开。 */
const PLAN_BADGE_COLOR = THEME.path;
/** 两个徽标之间的距离；与正文到徽标的间隔一致。 */
const BADGE_INNER_GAP = 2;

/** 信息行右端的呼吸空间：状态行与对话流都避开最右两列（一列间距加一列滚动条），徽标右缘对齐同一条竖线。 */
const INFO_RIGHT_MARGIN = 2;
/** 正文与徽标之间至少留出的间隔列数。 */
const BADGE_GAP = 2;

/**
 * 常驻信息行。
 *
 * 按「项目·分支 | 模型·思考强度 | 上下文 | 缓存命中率」分组；分支不存在时整段省略，
 * 上下文上限未声明时只写已用量。整行统一用暗色，避免和对话流正文抢注意力；审批徽标按模式
 * 着色，固定钉在行尾，一眼可辨当前放行到哪一档（Shift+Tab 切换）。Plan 模式在审批徽标
 * 左侧多一个 PLAN，两者正交：PLAN 管能不能改，审批管改的时候问不问。
 *
 * 终端变窄时按优先级整项舍弃正文，而不是从右侧硬截：先丢项目位置，再丢模型，再丢缓存，
 * 最后只保留上下文并截断。上下文是判断何时该压缩的依据，缓存命中率反映本回合的 token
 * 复用，这两项比位置与模型更值得留在窄屏上。徽标占的列从正文可用宽度里先扣掉，正文
 * 放不下时整段让位给徽标；Plan 模式下窄到放不下两个徽标时先舍审批徽标，PLAN 是当前
 * 工作方式的唯一提示，不能先消失。
 */
function infoLine(width: number, info: FooterInfo | undefined): string {
	if (info === undefined) return "";

	const badges: { readonly text: string; readonly color: string }[] = [];
	if (info.planMode === true) badges.push({ text: "PLAN", color: PLAN_BADGE_COLOR });
	if (info.approval !== undefined) {
		badges.push({ text: info.approval.toUpperCase(), color: APPROVAL_BADGE_COLORS[info.approval] });
	}

	// 窄屏先舍审批徽标，再舍 PLAN；两个都放不下时整段让位给正文
	let shown = badges;
	let badgeWidth = badgesWidth(shown);
	if (badgeWidth > 0 && width - INFO_RIGHT_MARGIN - badgeWidth < 1 && shown.length > 1) {
		shown = shown.filter((badge) => badge.text === "PLAN");
		badgeWidth = badgesWidth(shown);
	}
	const showBadges = shown.length > 0 && width - INFO_RIGHT_MARGIN - badgeWidth >= 1;
	if (!showBadges) {
		shown = [];
		badgeWidth = 0;
	}
	const badgeColumn = width - INFO_RIGHT_MARGIN - badgeWidth;
	const available = Math.max(
		0,
		width - INFO_RIGHT_MARGIN - (showBadges ? badgeWidth + BADGE_GAP : 0),
	);

	const location =
		info.branch === undefined
			? `${PROJECT_ICON} ${info.project}`
			: `${PROJECT_ICON} ${info.project} · ${BRANCH_ICON} ${info.branch}`;
	const model = `${MODEL_ICON} ${info.model} · ${EFFORT_ICON} ${info.effort}`;
	const context = `${CONTEXT_ICON} ${formatContext(info.contextUsed, info.contextWindow)}`;
	const cache = `${CACHE_ICON} ${Math.round(info.cacheHitRate * 100)}%`;

	let text = "";
	for (const group of [
		[location, model, context, cache],
		[model, context, cache],
		[context, cache],
		[context],
	]) {
		const candidate = group.join(" | ");
		if (displayWidth(candidate) <= available) {
			text = candidate;
			break;
		}
	}
	if (text === "" && available > 0) text = truncateToWidth(context, available).trimEnd();

	const body = text === "" ? "" : `${INFO_COLOR}${text}${RESET}`;
	if (!showBadges) return body;

	const gap = Math.max(1, badgeColumn - displayWidth(text));
	const styled = shown
		.map((badge) => `${badge.color}${badge.text}${RESET}`)
		.join(" ".repeat(BADGE_INNER_GAP));
	return `${body}${" ".repeat(gap)}${styled}`;
}

/** 徽标组的总显示宽度，含组内间隔。 */
function badgesWidth(badges: readonly { readonly text: string }[]): number {
	return badges.reduce((sum, badge) => sum + displayWidth(badge.text), 0) +
		Math.max(0, badges.length - 1) * BADGE_INNER_GAP;
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
	const metering =
		status.tokenLabel !== undefined
			? status.tokenLabel
			: status.tokens === undefined
				? undefined
				: `⇣${formatCompactTokens(status.tokens)}`;
	if (metering !== undefined) rightParts.push(metering);
	const right = rightParts.join("  ");

	// 状态文本可能是中文或带宽字符,长度一律按显示列算:按码元截断会让宽字符撑破行宽,
	// 右对齐的计时也会漂移
	let line: string;
	if (right.length === 0) {
		line = truncateToWidth(left, statusWidth);
	} else if (displayWidth(left) + displayWidth(right) + 2 <= statusWidth) {
		line = left + " ".repeat(statusWidth - displayWidth(left) - displayWidth(right)) + right;
	} else {
		line = truncateToWidth(`${left}  ${right}`, statusWidth);
	}

	// 扫光只覆盖活动描述；阶段计时、总计时和 token 保持静态的 #6b7580
	const visibleActivity = line.slice(0, Math.min(activity.length, line.length));
	const rest = line.slice(visibleActivity.length);
	const toneColor =
		status.tone === "error" ? ERROR_COLOR : status.tone === "warning" ? WARNING_COLOR : NOTICE_COLOR;
	const head =
		status.tone !== undefined
			? `${toneColor}${visibleActivity}${RESET}`
			: status.sweep === undefined
				? `${ACCENT_COLOR}${visibleActivity}${RESET}`
				: swept(visibleActivity, status.sweep, SWEEP_BASE, SWEEP_HIGHLIGHT);
	return head + (rest.length > 0 ? `${STATUS_META_COLOR}${rest}${RESET}` : "");
}

function formatContext(used: number, total: number | undefined): string {
	const current = formatCompactTokens(used);
	return total === undefined ? current : `${current} / ${formatCompactTokens(total)}`;
}

/** 按显示宽度截断，宽字符与 emoji 不会被切成半个。 */
function colored(text: string, color: string): string {
	return `${color}${text}${RESET}`;
}

/**
 * 输入框边框与命令名颜色：聚焦时随审批模式变化。
 *
 * ask 用强调青、auto 用琥珀、yolo 用红色：输入框本身就能提示当前放行到哪一档，
 * 不必只盯着右下角的徽标。失焦时统一用边框色，不参与风险提示。
 */
function frameColor(focused: boolean, approval: ApprovalMode | undefined): string {
	if (!focused) return BLUR_COLOR;
	if (approval === "auto") return THEME.warning;
	if (approval === "yolo") return THEME.error;
	return FOCUS_COLOR;
}

function horizontal(width: number): string {
	return "─".repeat(width);
}
