import { renderMarkdown } from "#src/tui/render/markdown.ts";
import { displayWidth, truncateToWidth } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";
import type { TranscriptPlan } from "#src/tui/transcript.ts";
import { ACTIONS, PAGE } from "#src/tui/copy.ts";

/**
 * 计划审批页。
 *
 * 计划正文沿用助手回复的 Markdown 排版；动作条固定在视口底部，计划再长也不用来回滚动
 * 才能找到批准键。页面本身只负责排版，滚动、按键与模式切换由 layout 决定。
 */

/** 底部固定区：一条分隔线加一行动作。 */
export const PLAN_ACTION_HEIGHT = 2;

const TITLE = PAGE.planTitle;
const COMPACT_ACTIONS = `a ${ACTIONS.approveShort}  r ${ACTIONS.reviseShort}  q ${ACTIONS.leaveShort}  Esc ${ACTIONS.close}`;
const SCROLL_HINT = `↑/↓ ${ACTIONS.scroll}`;
const ACTION_LABEL_COLOR = THEME.textSecondary;
const KEY_COLOR = THEME.accent;
const LEAVE_KEY_COLOR = THEME.warning;
const CLOSE_KEY_COLOR = THEME.textSubtle;
const RESET = THEME.reset;

interface ActionKey {
	readonly key: string;
	readonly label: string;
	readonly color: string;
}

const FULL_KEYS: readonly ActionKey[] = [
	{ key: "a", label: ACTIONS.approve, color: KEY_COLOR },
	{ key: "r", label: ACTIONS.revise, color: KEY_COLOR },
	{ key: "q", label: ACTIONS.leave, color: LEAVE_KEY_COLOR },
	{ key: "Esc", label: ACTIONS.close, color: CLOSE_KEY_COLOR },
];

const COMPACT_KEYS: readonly ActionKey[] = [
	{ key: "a", label: ACTIONS.approveShort, color: KEY_COLOR },
	{ key: "r", label: ACTIONS.reviseShort, color: KEY_COLOR },
	{ key: "q", label: ACTIONS.leaveShort, color: LEAVE_KEY_COLOR },
	{ key: "Esc", label: ACTIONS.close, color: CLOSE_KEY_COLOR },
];

/** 审批页正文：标题、空行与完整计划。 */
export function planReviewLines(plan: TranscriptPlan, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const shown = truncateToWidth(TITLE, columns);
	const title = `${THEME.accent}${shown}${RESET}${" ".repeat(Math.max(0, columns - displayWidth(shown)))}`;
	return [title, " ".repeat(columns), ...renderMarkdown(plan.text, columns)];
}

/** 底部动作条：分隔线加固定按键提示；窄屏换成短标签，再窄就整段截断。 */
export function planActionLines(width: number): readonly string[] {
	const columns = Math.max(0, width);
	const rule = `${THEME.border}${"─".repeat(columns)}${RESET}`;
	if (columns === 0) return ["", ""];

	const full = actionLine(FULL_KEYS, "   ");
	if (full.width + 2 + displayWidth(SCROLL_HINT) <= columns) {
		const gap = " ".repeat(columns - full.width - displayWidth(SCROLL_HINT));
		return [rule, `${full.text}${gap}${THEME.textSubtle}${SCROLL_HINT}${RESET}`];
	}
	if (full.width <= columns) {
		return [rule, `${full.text}${" ".repeat(columns - full.width)}`];
	}

	const compact = actionLine(COMPACT_KEYS, "  ");
	if (compact.width <= columns) {
		return [rule, `${compact.text}${" ".repeat(columns - compact.width)}`];
	}
	const plain = truncateToWidth(COMPACT_ACTIONS, columns);
	return [rule, `${plain}${" ".repeat(Math.max(0, columns - displayWidth(plain)))}`];
}

interface ActionLine {
	readonly text: string;
	readonly width: number;
}

function actionLine(keys: readonly ActionKey[], gap: string): ActionLine {
	const text = keys
		.map((key) => `${key.color}${key.key}${RESET} ${ACTION_LABEL_COLOR}${key.label}${RESET}`)
		.join(gap);
	const plain = keys.map((key) => `${key.key} ${key.label}`).join(gap);
	return { text, width: displayWidth(plain) };
}
