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
import { OUTER_PAD } from "./layout.ts";
import { INPUT_LEFT } from "./input-box.ts";
import { ACCENT, BRIGHT, DIM, FAINT, TEXT } from "./theme.ts";

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
	readonly notice: string;
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
}

/**
 * 跑起来时的那一行。
 *
 * 两个耗时回答的是不同的问题——「这一步卡了多久」与「这一轮总共多久」，所以都留着：判断卡死
 * 看前者，说进度看后者。整行占的正是输入框的内区：左沿与提示符同列，右缘收在右边框内侧，
 * 上下两块才对得齐。动作名放不下时截断，两个计时都不截，它们是这两个问题的唯一依据。
 */
export function runningRow(state: RunningRowState): Line {
	const now = state.now ?? Date.now();
	const elapsed = now - state.startedAt;
	const spin = styled(`${spinnerFrame(elapsed)} `, ACCENT);
	const phase = styled(` ${formatDuration(now - state.phaseStartedAt)}`, DIM);
	const right = styled(
		state.tokens > 0
			? `${formatDuration(elapsed)} ⇣${formatTokens(state.tokens)}`
			: formatDuration(elapsed),
		DIM,
	);
	// 输入框内区右沿：右边框那一格留给边框自己
	const span = Math.max(1, state.width - OUTER_PAD - 1);
	// 先给两个计时与它们之间的一格空档留位，余下的宽度才归动作名
	const room = Math.max(1, span - INPUT_LEFT - lineWidth(spin) - lineWidth(phase) - lineWidth(right) - 1);
	const label = truncateLine(styled(state.activity, TEXT), room);
	return alignEnds(concat(plain(" ".repeat(INPUT_LEFT)), spin, label, phase), right, span);
}

/** 上下文规模的紧凑写法：一万以内留两位小数，十万以内一位，再往上按千、兆取整。 */
function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(2)}k`;
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.floor(tokens / 1_000)}k`;
	if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(2)}m`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

/** 底部快捷键条：临时信息优先，其次才是按键提示。 */
export function footerRow(state: FooterState): Line {
	const line = noticeOrHints(state);
	const space = concat(plain(" ".repeat(OUTER_PAD)), line);
	return padTo(space, state.width);
}

function noticeOrHints(state: FooterState): Line {
	if (state.notice.length > 0) return truncateLine(styled(state.notice, ACCENT), state.width - OUTER_PAD);
	return hintLine(state.hints, state.width - OUTER_PAD);
}

function padTo(line: Line, width: number): Line {
	if (lineWidth(line) >= width) return line;
	return concat(line, plain(" ".repeat(width - lineWidth(line))));
}

/** 当前该显示哪几条按键。 */
export function footerHints(state: {
	readonly dialog: boolean;
	readonly pane: "prompt" | "scrollback";
	readonly menu: "slash" | "file" | undefined;
	readonly running: boolean;
	readonly following: boolean;
	readonly editorEmpty: boolean;
}): readonly KeyHint[] {
	const help: KeyHint = { keys: "/help", label: "shortcuts" };
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
			{ keys: "y/Y", label: "copy/meta" },
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
			{ keys: "Esc/Ctrl+C", label: "cancel" },
			{ keys: "PageUp", label: "page" },
			help,
		];
	}
	return [
		{ keys: "Enter", label: "send" },
		{ keys: "Ctrl+J", label: "newline" },
		{ keys: "Ctrl+V", label: "paste" },
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
