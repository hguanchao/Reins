import {
	alignEnds,
	concat,
	formatDuration,
	spinnerFrame,
	styled,
	truncateLine,
	type Line,
	type Span,
} from "../../tui/index.ts";
import { fullTimestamp } from "./session-format.ts";
import { ACCENT, BRIGHT, DIM, FAINT, TEXT } from "./theme.ts";

/**
 * 输入框下面的两行：运行状态与快捷键条。
 *
 * 状态行左侧是当前动作，右侧是本轮耗时；快捷键条按当前场景切换，复制结果、时间戳展开和
 * 回合预览都会临时占用这一行，用完再让回给按键提示。
 */

export interface KeyHint {
	readonly keys: string;
	readonly label: string;
}

export interface HintState {
	readonly dialog: boolean;
	readonly pane: "prompt" | "scrollback";
	readonly menu: "slash" | "file" | undefined;
	readonly running: boolean;
	readonly following: boolean;
	readonly editorEmpty: boolean;
}

export interface FooterState {
	readonly width: number;
	readonly notice: string;
	readonly hoverTimestamp: number | undefined;
	readonly hoverTurn: number | undefined;
	readonly hoverPreview: string;
	readonly hints: readonly KeyHint[];
}

/** 跑起来时的那一行：左边是当前动作，右边是这一轮已经跑了多久。 */
export function runningRow(activity: string, startedAt: number, width: number, now = Date.now()): Line {
	const elapsed = now - startedAt;
	const head = concat(styled(`${spinnerFrame(elapsed)} `, ACCENT), styled(activity, TEXT));
	return alignEnds(head, styled(formatDuration(elapsed), DIM), width);
}

/** 底部快捷键条：临时信息优先，其次才是按键提示。 */
export function footerRow(state: FooterState): Line {
	if (state.notice.length > 0) return truncateLine(styled(state.notice, ACCENT), state.width);
	if (state.hoverTimestamp !== undefined) {
		return truncateLine(
			concat(styled("▸ ", FAINT), styled(fullTimestamp(state.hoverTimestamp), BRIGHT)),
			state.width,
		);
	}
	if (state.hoverTurn !== undefined) {
		const label = state.hoverTurn > 0 ? `Turn ${state.hoverTurn}` : "Turn";
		return truncateLine(
			concat(
				styled("▸ ", FAINT),
				styled(label, BRIGHT),
				styled(state.hoverPreview.length > 0 ? ` · ${state.hoverPreview}` : "", DIM),
			),
			state.width,
		);
	}
	return hintLine(state.hints, state.width);
}

/** 当前该显示哪几条按键。 */
export function footerHints(state: HintState): readonly KeyHint[] {
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
