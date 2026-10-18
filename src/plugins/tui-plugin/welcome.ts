import {
	concat,
	lineWidth,
	plain,
	styled,
	truncateLine,
	type Line,
} from "../../tui/index.ts";
import { ACCENT, DIM, EDGE, FAINT, TEAL } from "./theme.ts";

/**
 * 新会话的首屏。
 *
 * 一句话都没说之前，会话区摆的是品牌与入口提示；第一次提交后由会话记录接管，这层就不
 * 再出现。终端太矮时逐级降级：完整卡片 → 标题加提示 → 只留标题，宁可少画也不把输入框
 * 挤出去。
 */

/** 品牌字：用块字符拼的 REINS，不依赖终端字体里的特殊字形。 */
const LOGO = [
	"██████╗ ███████╗██╗███╗   ██╗███████╗",
	"██╔══██╗██╔════╝██║████╗  ██║██╔════╝",
	"██████╔╝█████╗  ██║██╔██╗ ██║███████╗",
	"██╔══██╗██╔══╝  ██║██║╚██╗██║╚════██║",
	"██║  ██║███████╗██║██║ ╚████║███████║",
	"╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝╚══════╝",
] as const;

const TAGLINE = "A terminal coding agent";
const START_HINT = "Type a message below to start.";

const HINTS = [
	{ keys: "/help", label: "commands and keys" },
	{ keys: "@file", label: "attach a file" },
	{ keys: "Ctrl+D", label: "quit (press twice)" },
] as const;

export interface WelcomeState {
	readonly width: number;
	readonly rows: number;
}

export function welcomeRows(state: WelcomeState): readonly Line[] {
	const content =
		state.width >= 60 && state.rows >= 18
			? boxed(state.width)
			: state.rows >= 8
				? compact(state.width, true)
				: state.rows >= 5
					? compact(state.width, false)
					: [centered(styled("REINS", { bold: true, color: TEAL.color }), state.width)];

	const top = Math.max(0, Math.floor((state.rows - content.length) / 2));
	const lines: Line[] = [];
	for (let index = 0; index < top; index += 1) lines.push(plain(""));
	lines.push(...content.slice(0, state.rows - top));
	while (lines.length < state.rows) lines.push(plain(""));
	return lines;
}

/** 完整卡片：品牌字、说明与入口提示都装进一个圆角框。 */
function boxed(width: number): readonly Line[] {
	const boxWidth = Math.min(Math.max(44, width - 8), 64);
	const inner = boxWidth - 2;
	const content: Line[] = [
		plain(""),
		...LOGO.map((line, index) => centered(styled(line, index < 3 ? TEAL : ACCENT), inner)),
		plain(""),
		centered(styled("REINS", { bold: true, color: TEAL.color }), inner),
		centered(styled(TAGLINE, DIM), inner),
		...HINTS.map((hint) => centered(hintLine(hint.keys, hint.label), inner)),
		plain(""),
		centered(styled(START_HINT, FAINT), inner),
		plain(""),
	];

	const margin = Math.max(0, Math.floor((width - boxWidth) / 2));
	const rule = "─".repeat(boxWidth - 2);
	const frame = (line: Line, top = false, bottom = false): Line => {
		const left = top ? "╭" : bottom ? "╰" : "│";
		const right = top ? "╮" : bottom ? "╯" : "│";
		return concat(
			plain(" ".repeat(margin)),
			styled(left, EDGE),
			padTo(line, inner),
			styled(right, EDGE),
		);
	};

	return [
		frame(styled(rule, EDGE), true, false),
		...content.map((line) => frame(line)),
		frame(styled(rule, EDGE), false, true),
	];
}

/** 矮屏：不要框，只留标题、说明与提示。 */
function compact(width: number, withHints: boolean): readonly Line[] {
	const lines: Line[] = [
		centered(styled("REINS", { bold: true, color: TEAL.color }), width),
		centered(styled(TAGLINE, DIM), width),
	];
	if (withHints) {
		lines.push(plain(""));
		for (const hint of HINTS) lines.push(centered(hintLine(hint.keys, hint.label), width));
		lines.push(plain(""));
	}
	lines.push(centered(styled(START_HINT, FAINT), width));
	return lines;
}

function hintLine(keys: string, label: string): Line {
	return concat(styled(keys.padEnd(8), ACCENT), styled(label, DIM));
}

/** 居中并按宽度补齐；放不下时截断。 */
function centered(line: Line, width: number): Line {
	const fitted = lineWidth(line) > width ? truncateLine(line, width) : line;
	const space = Math.max(0, width - lineWidth(fitted));
	const left = Math.floor(space / 2);
	return concat(plain(" ".repeat(left)), fitted, plain(" ".repeat(space - left)));
}

function padTo(line: Line, width: number): Line {
	if (lineWidth(line) >= width) return line;
	return concat(line, plain(" ".repeat(width - lineWidth(line))));
}
