import {
	alignEnds,
	concat,
	lineWidth,
	plain,
	styled,
	spinnerFrame,
	formatDuration,
	truncateLine,
	type Line,
	type Span,
} from "../../tui/index.ts";
import { formatTokens } from "./format.ts";
import { OUTER_PAD } from "./layout.ts";
import { INPUT_LEFT } from "./input-box.ts";
import { ACCENT, BAD, BRIGHT, DIM, FAINT } from "./theme.ts";

/**
 * 输入区上下各有一行：上面是运行状态，下面是快捷键条，都与会话条目共用同一段左外边距。
 *
 * 状态行左侧是指示器、当前动作和这一步的耗时，右侧是整轮的耗时；快捷键条按当前场景切换，
 * 复制结果与粘贴提示会临时占用这一行，用完再让给按键提示。
 */

export interface KeyHint {
	readonly keys: string;
	readonly label: string;
}

export interface FooterState {
	readonly width: number;
	readonly hints: readonly KeyHint[];
}

export interface RunningRowState {
	/** 当前动作：思考、跑某个工具、压上下文 */
	readonly activity: string;
	/** 这一轮的起点 */
	readonly startedAt: number;
	/** 当前动作的起点：这一步已经跑了多久从它算 */
	readonly phaseStartedAt: number;
	/** 当前上下文里的 token 估算；0 表示还没有数，不显示 */
	readonly tokens: number;
	readonly width: number;
	readonly now?: number;
	/** 是否还在跟尾；翻上去看历史时右侧出现回到底部的按钮 */
	readonly following?: boolean;
	/** 已经发出中止请求：动作名改成 Cancelling…，收起停止按钮 */
	readonly cancelling?: boolean;
	/** 队列里还有几条后续消息 */
	readonly queued?: number;
	/** 指针是否停在停止/跟随按钮上 */
	readonly stopHover?: boolean;
	readonly followHover?: boolean;
}

/** 运行状态行以及其中可点击按钮的列范围。 */
export interface RunningRowRender {
	readonly line: Line;
	/** 回到底部的 `[↓]`；跟尾时不出现 */
	readonly follow?: { readonly from: number; readonly to: number };
	/** 中止本轮的 `[stop]`；已经在中止时不出现 */
	readonly stop?: { readonly from: number; readonly to: number };
}

/**
 * 跑起来时的那一行。
 *
 * 两个耗时回答的是不同的问题——「这一步卡了多久」与「这一轮总共多久」，所以都留着：判断卡死
 * 看前者，说进度看后者。整行占的正是输入框的内区：左沿与提示符同列，右缘收在右边框内侧，
 * 上下两块才对得齐。动作名放不下时截断，两个计时都不截，它们是这两个问题的唯一依据。
 *
 * 右侧按钮贴着右缘：翻上去时先出现 `[↓]` 回到底部，`[stop]` 始终在最后。
 */
export function runningRow(state: RunningRowState): RunningRowRender {
	const now = state.now ?? Date.now();
	const elapsed = now - state.startedAt;
	const spin = styled(`${spinnerFrame(elapsed)} `, ACCENT);
	const queueLabel =
		state.queued !== undefined && state.queued > 0 ? ` · ${state.queued} queued` : "";
	// 窄屏先让阶段计时让位：动作名与整轮计时更要紧
	const phase =
		state.width < 60
			? plain("")
			: styled(` ${formatDuration(now - state.phaseStartedAt)}${queueLabel}`, DIM);
	const timers = styled(
		state.tokens > 0
			? `${formatDuration(elapsed)} ⇣${formatTokens(state.tokens)}`
			: formatDuration(elapsed),
		DIM,
	);

	const followText = state.following === false ? "[↓]" : "";
	const stopText = state.cancelling === true ? "" : "[stop]";
	const followStyle = state.followHover === true ? ACCENT : DIM;
	const stopStyle = state.stopHover === true ? BAD : DIM;
	const right = concat(
		timers,
		followText.length > 0 || stopText.length > 0 ? styled("  ", DIM) : plain(""),
		followText.length > 0 ? styled(followText, followStyle) : plain(""),
		followText.length > 0 && stopText.length > 0 ? plain(" ") : plain(""),
		stopText.length > 0 ? styled(stopText, stopStyle) : plain(""),
	);

	// 输入框内区右沿：右边框那一格留给边框自己
	const span = Math.max(1, state.width - OUTER_PAD - 1);
	// 先给两个计时、按钮与它们之间的空档留位，余下的宽度才归动作名
	const room = Math.max(1, span - INPUT_LEFT - lineWidth(spin) - lineWidth(phase) - lineWidth(right) - 1);
	const activity = state.cancelling === true ? "Cancelling…" : state.activity;
	const label = truncateLine(styled(activity, BRIGHT), room);
	const line = alignEnds(concat(plain(" ".repeat(INPUT_LEFT)), spin, label, phase), right, span);

	// 左右两段撑不下时 alignEnds 会整段丢弃右侧，按钮也就不存在了
	if (lineWidth(line) < lineWidth(right)) return { line };

	const stop = stopText.length === 0 ? undefined : { from: span - stopText.length, to: span };
	const follow =
		followText.length === 0
			? undefined
			: {
					from: span - stopText.length - (stopText.length > 0 ? 1 : 0) - followText.length,
					to: span - stopText.length - (stopText.length > 0 ? 1 : 0),
				};
	return { line, ...(follow === undefined ? {} : { follow }), ...(stop === undefined ? {} : { stop }) };
}

/** 底部快捷键条。临时信息不再占用这一行，改成输入框上方的 toast。 */
export function footerRow(state: FooterState): Line {
	const space = concat(plain(" ".repeat(OUTER_PAD)), hintLine(state.hints, state.width - OUTER_PAD));
	return padTo(space, state.width);
}

function padTo(line: Line, width: number): Line {
	if (lineWidth(line) >= width) return line;
	return concat(line, plain(" ".repeat(width - lineWidth(line))));
}

/** 当前该显示哪几条按键。 */
export function footerHints(state: {
	readonly dialog: boolean;
	readonly viewer: boolean;
	readonly pane: "prompt" | "scrollback";
	readonly menu: "slash" | "file" | "history" | undefined;
	readonly running: boolean;
	readonly following: boolean;
	readonly editorEmpty: boolean;
	readonly hasStash: boolean;
}): readonly KeyHint[] {
	const help: KeyHint = { keys: "/help", label: "shortcuts" };
	if (state.viewer) {
		return [
			{ keys: "j/k", label: "scroll" },
			{ keys: "PgUp/PgDn", label: "page" },
			{ keys: "Esc", label: "close" },
		];
	}
	if (state.dialog) {
		return [
			{ keys: "↑/↓", label: "select" },
			{ keys: "Enter", label: "confirm" },
			{ keys: "Esc", label: "deny" },
		];
	}
	if (state.pane === "scrollback") {
		return [
			{ keys: "j/k", label: "entry" },
			{ keys: "e", label: "fold" },
			{ keys: "h/l", label: "fold" },
			{ keys: "r", label: "raw" },
			{ keys: "v", label: "view" },
			{ keys: "y/Y/c", label: "copy/meta/arg" },
			{ keys: "g/G", label: "top/btm" },
			{ keys: "Tab", label: "prompt" },
		];
	}
	if (state.menu === "slash") {
		return [
			{ keys: "↑/↓", label: "select" },
			{ keys: "Tab", label: "complete" },
			{ keys: "Enter", label: "run" },
			{ keys: "Esc", label: "close" },
		];
	}
	if (state.menu === "file") {
		return [
			{ keys: "↑/↓", label: "select" },
			{ keys: "Tab/Enter", label: "insert" },
			{ keys: "→", label: "drill" },
			{ keys: "Esc", label: "close" },
		];
	}
	if (state.menu === "history") {
		return [
			{ keys: "↑/↓", label: "select" },
			{ keys: "Enter", label: "insert" },
			{ keys: "Esc", label: "close" },
		];
	}
	if (!state.following) {
		return [
			{ keys: "PageUp/PageDown", label: "page" },
			{ keys: "Ctrl+P/N", label: "line" },
			{ keys: "End", label: "bottom" },
			help,
		];
	}
	if (state.running) {
		return [
			...(state.editorEmpty ? [] : [{ keys: "Enter", label: "queue" }]),
			{ keys: "Ctrl+C", label: "cancel" },
			{ keys: "PageUp", label: "page" },
			help,
		];
	}
	return [
		{ keys: "Enter", label: "send" },
		{ keys: "Ctrl+J", label: "newline" },
		{ keys: "Ctrl+V", label: "paste" },
		{ keys: "Ctrl+S", label: state.hasStash && state.editorEmpty ? "restore" : "stash" },
		{ keys: "↑/↓", label: state.editorEmpty ? "history" : "move" },
		{ keys: "Ctrl+D", label: "quit" },
		help,
	];
}

/** 一行按键提示：键亮、动作暗，段与段之间用竖线分开。 */
function hintLine(hints: readonly KeyHint[], width: number): Line {
	const parts: Span[] = [];
	for (let index = 0; index < hints.length; index += 1) {
		const hint = hints[index];
		if (index > 0) parts.push(...styled("  │  ", FAINT));
		parts.push(...styled(hint.keys, { color: BRIGHT.color, bold: true }));
		parts.push(...styled(`:${hint.label}`, DIM));
	}
	return truncateLine(parts, width);
}
