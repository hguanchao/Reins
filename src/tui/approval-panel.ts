import type { ApprovalPrompt } from "../permission/approval.ts";
import type { ApprovalAnswer } from "../permission/policy.ts";
import { displayToolName } from "../tools/describe.ts";
import {
	ACCENT_COLOR,
	BORDER_COLOR,
	PANEL_BG,
	RESET,
} from "./menu-panel.ts";
import { displayWidth, truncateToWidth } from "./text.ts";
import { THEME } from "./theme.ts";

/**
 * 工具审批面板。
 *
 * 六行：标题边框、工具与参数、参数续行、导航提示、动作行、下边框。
 * 工具名与参数分层；参数最多两行；动作行按宽度逐级退化；选中动作加粗。
 */

export const APPROVAL_PANEL_HEIGHT = 6;

const TITLE = "Permission required";
const HINT = "←/→ select · Enter confirm · Esc deny";
/** 选中动作前的标记，与用户提示和工具调用保持一致。 */
const ACTION_MARKER = "› ";
/** 未选中的动作用同宽空白占位，移动高亮时文字不左右跳。 */
const ACTION_SLOT = " ".repeat(displayWidth(ACTION_MARKER));
/** 选中项加粗；之后必须关掉，否则后面的动作也会跟着变粗。 */
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

export function renderApprovalPanel(
	width: number,
	prompt: ApprovalPrompt,
	selected: ApprovalAnswer = "once",
): readonly string[] {
	const columns = Math.max(1, width);
	const detail = detailLines(columns, prompt);
	const actions = actionRow(columns, prompt, selected);

	return [
		titleBorder(columns),
		toolLine(columns, prompt, detail),
		continuationLine(columns, prompt, detail),
		hintLine(columns),
		styledContent(`  ${actions.styled}`, 2 + actions.width, columns),
		bottomBorder(columns),
	];
}

function titleBorder(width: number): string {
	const label = ` ${TITLE} `;
	const labelWidth = displayWidth(label);
	if (labelWidth >= width) return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;

	const left = Math.floor((width - labelWidth) / 2);
	const right = width - labelWidth - left;
	return `${BORDER_COLOR}${"─".repeat(left)}${THEME.warning}${label}${BORDER_COLOR}${"─".repeat(right)}${RESET}`;
}

function bottomBorder(width: number): string {
	return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;
}

/** 已经带样式的行：按纯文本宽度补空格，不能再用 padEnd 量带 ANSI 的字符串。 */
function styledContent(styled: string, plainWidth: number, width: number): string {
	const padding = " ".repeat(Math.max(0, width - plainWidth));
	return `${PANEL_BG}${styled}${padding}${RESET}`;
}

interface DetailLines {
	readonly tool: string;
	readonly first: string;
	readonly second: string;
	/** 第二行缩进到参数首字所需的列数 */
	readonly prefixWidth: number;
}

/** 工具名与参数分层：工具名青色，文件路径用路径蓝，其余参数用正文色。 */
function toolLine(width: number, prompt: ApprovalPrompt, detail: DetailLines): string {
	const leading = "  ";
	const gap = "  ";
	const used =
		displayWidth(leading) + displayWidth(detail.tool) + displayWidth(gap) + displayWidth(detail.first);
	const padding = " ".repeat(Math.max(0, width - used));
	return `${PANEL_BG}${ACCENT_COLOR}${leading}${detail.tool}${detailColor(prompt)}${gap}${detail.first}${padding}${RESET}`;
}

/** 参数续行与参数首字对齐；短参数时整行留白。 */
function continuationLine(width: number, prompt: ApprovalPrompt, detail: DetailLines): string {
	const indent = " ".repeat(detail.prefixWidth);
	const used = detail.prefixWidth + displayWidth(detail.second);
	const padding = " ".repeat(Math.max(0, width - used));
	return `${PANEL_BG}${detailColor(prompt)}${indent}${detail.second}${padding}${RESET}`;
}

/** 导航提示：y/a/n 已经写在动作里，这里补上左右与确认、拒绝键。 */
function hintLine(width: number): string {
	const text = truncateToWidth(`  ${HINT}`, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
	return `${PANEL_BG}${THEME.textSubtle}${text}${padding}${RESET}`;
}

function detailColor(prompt: ApprovalPrompt): string {
	return prompt.tool === "edit" || prompt.tool === "write" ? THEME.path : THEME.textPrimary;
}

/** 把工具展示名与参数铺成最多两行；第二行仍放不下就在末尾省略。 */
function detailLines(width: number, prompt: ApprovalPrompt): DetailLines {
	const tool = displayToolName(prompt.tool);
	const prefixWidth = 2 + displayWidth(tool) + 2;
	const limit = Math.max(1, width - prefixWidth);
	const detail = compact(prompt.detail);

	const first = truncateToWidth(detail, limit);
	const rest = detail.slice(first.length);
	if (rest.length === 0) return { tool, first, second: "", prefixWidth };

	let second = truncateToWidth(rest, limit);
	if (second.length < rest.length) {
		// 省略号自己也占一列；先少取一个字符再补上
		second = `${truncateToWidth(rest, Math.max(0, limit - 1))}…`;
	}
	return { tool, first, second, prefixWidth };
}

interface ActionOption {
	readonly action: ApprovalAnswer;
	readonly label: string;
}

interface ActionRow {
	readonly styled: string;
	readonly width: number;
}

/**
 * 动作行。
 *
 * 先按宽度从“带完整范围”到“只有按键”逐级退化，避免窄终端下拒绝键被截掉；再把当前选中
 * 的动作高亮加粗。只有选中项前面显示 ›，未选中项用同宽空白占位。
 */
function actionRow(width: number, prompt: ApprovalPrompt, selected: ApprovalAnswer): ActionRow {
	const options = layoutActions(width, prompt);
	const plain = options.map((option) => option.label).join("   ");
	const styled = options
		.map((option) => {
			if (option.action !== selected) {
				return `${ACTION_SLOT}${option.label.slice(ACTION_MARKER.length)}`;
			}
			// 拒绝用危险色，其余用强调色：选到拒绝时一眼能看出这是危险动作
			const color = option.action === "deny" ? THEME.error : ACCENT_COLOR;
			return `${BOLD}${color}${option.label}${BOLD_OFF}${THEME.textPrimary}`;
		})
		.join("   ");
	return { styled, width: displayWidth(plain) };
}

/** 动作行里某一列对应的动作；列从 0 起算，用于鼠标命中。 */
export function approvalActionAt(
	width: number,
	prompt: ApprovalPrompt,
	column: number,
): ApprovalAnswer | undefined {
	const options = layoutActions(Math.max(1, width), prompt);
	let start = 2;
	for (const option of options) {
		const end = start + displayWidth(option.label);
		if (column >= start && column < end) return option.action;
		start = end + 3;
	}
	return undefined;
}

/** 可记住范围的文案：文件类不重复路径，Bash 保留具体命令前缀。 */
function alwaysLabel(prompt: ApprovalPrompt): string | undefined {
	if (prompt.saveShort === undefined) return undefined;
	if (prompt.tool === "edit" || prompt.tool === "write") return "always for this file";
	if (prompt.tool === "bash") return `always for "${prompt.saveShort}"`;
	return `always: "${prompt.saveShort}"`;
}

function layoutActions(width: number, prompt: ApprovalPrompt): readonly ActionOption[] {
	const available = width - 2;
	const once: ActionOption = { action: "once", label: `${ACTION_MARKER}[y] allow once` };
	const deny: ActionOption = { action: "deny", label: `${ACTION_MARKER}[n] deny` };
	const rowWidth = (options: readonly ActionOption[]): number =>
		displayWidth(options.map((option) => option.label).join("   "));

	const alwaysText = alwaysLabel(prompt);
	if (alwaysText === undefined) {
		const full = [once, deny];
		return rowWidth(full) <= available
			? full
			: [
					{ action: "once", label: `${ACTION_MARKER}[y]` },
					{ action: "deny", label: `${ACTION_MARKER}[n]` },
				];
	}

	const full = [
		once,
		{ action: "always" as const, label: `${ACTION_MARKER}[a] ${alwaysText}` },
		deny,
	];
	if (rowWidth(full) <= available) return full;

	const compact = [
		once,
		{ action: "always" as const, label: `${ACTION_MARKER}[a] always` },
		deny,
	];
	if (rowWidth(compact) <= available) return compact;

	const shortest: readonly ActionOption[] = [
		{ action: "once", label: `${ACTION_MARKER}[y] once` },
		{ action: "always", label: `${ACTION_MARKER}[a] always` },
		deny,
	];
	if (rowWidth(shortest) <= available) return shortest;

	return [
		{ action: "once", label: `${ACTION_MARKER}[y]` },
		{ action: "always", label: `${ACTION_MARKER}[a]` },
		{ action: "deny", label: `${ACTION_MARKER}[n]` },
	];
}

/** 参数是格式化过的 JSON 或命令文本，压成一行才能放进固定高度的面板。 */
function compact(detail: string): string {
	const oneLine = detail.replace(/\s+/g, " ").trim();
	return oneLine.length > 0 ? oneLine : "(no arguments)";
}
