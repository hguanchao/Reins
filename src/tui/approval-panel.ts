import { eastAsianWidth } from "get-east-asian-width";
import type { ApprovalPrompt } from "../permission/approval.ts";
import type { ApprovalAnswer } from "../permission/policy.ts";
import { displayToolName } from "../tools/describe.ts";
import {
	ACCENT_COLOR,
	BORDER_COLOR,
	PANEL_BG,
	RESET,
	displayWidth,
	padEnd,
} from "./menu-panel.ts";
import { THEME } from "./theme.ts";

/**
 * 工具审批面板。
 *
 * 卡片式六行：标题边框、工具:参数（最多两行）、空行、动作行、下边框。动作行可以用左右键
 * 移动高亮、回车确认，y/a/n 仍可直接执行；参数放不下时在第二行续写，仍放不下就在末尾省略。
 */

export const APPROVAL_PANEL_HEIGHT = 6;

const TITLE = "Permission required";
/** 选中动作前的标记，与用户提示和工具调用保持一致。 */
const ACTION_MARKER = "› ";
/** 未选中的动作用同宽空白占位，移动高亮时文字不左右跳。 */
const ACTION_SLOT = " ".repeat(displayWidth(ACTION_MARKER));

export function renderApprovalPanel(
	width: number,
	prompt: ApprovalPrompt,
	selected: ApprovalAnswer = "once",
): readonly string[] {
	const columns = Math.max(1, width);
	const [detail, continuation] = detailLines(columns, prompt);
	const actions = actionRow(columns, prompt, selected);

	return [
		titleBorder(columns),
		content(detail, columns, THEME.textPrimary),
		content(continuation, columns, THEME.textPrimary),
		content("", columns, THEME.textPrimary),
		styledContent(`  ${actions.styled}`, 2 + actions.width, columns),
		`${BORDER_COLOR}${"─".repeat(columns)}${RESET}`,
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

/** 一行内容：统一铺满面板底色，超宽时截断。 */
function content(text: string, width: number, color: string): string {
	return `${PANEL_BG}${color}${padEnd(text, width)}${RESET}`;
}

/** 已经带样式的行：按纯文本宽度补空格，不能再用 padEnd 量带 ANSI 的字符串。 */
function styledContent(styled: string, plainWidth: number, width: number): string {
	const padding = " ".repeat(Math.max(0, width - plainWidth));
	return `${PANEL_BG}${styled}${padding}${RESET}`;
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
 * 的动作高亮。只有选中项前面显示 ›，未选中项用同宽空白占位。左右键移动、回车确认都由
 * 界面负责，这里只负责显示。
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
			return `${color}${option.label}${THEME.textPrimary}`;
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

function layoutActions(width: number, prompt: ApprovalPrompt): readonly ActionOption[] {
	const available = width - 2;
	const once: ActionOption = { action: "once", label: `${ACTION_MARKER}[y] allow once` };
	const deny: ActionOption = { action: "deny", label: `${ACTION_MARKER}[n] deny` };
	const rowWidth = (options: readonly ActionOption[]): number =>
		displayWidth(options.map((option) => option.label).join("   "));

	if (prompt.saveShort === undefined) {
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
		{ action: "always" as const, label: `${ACTION_MARKER}[a] always: "${prompt.saveShort}"` },
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

/** 把工具展示名与参数铺成最多两行；第二行仍放不下就在末尾省略。 */
function detailLines(width: number, prompt: ApprovalPrompt): readonly [string, string] {
	const prefix = `  ${displayToolName(prompt.tool)}: `;
	const indent = " ".repeat(displayWidth(prefix));
	const firstLimit = Math.max(1, width - displayWidth(prefix));
	const secondLimit = Math.max(1, width - displayWidth(indent));
	const detail = compact(prompt.detail);

	const first = takeWidth(detail, firstLimit);
	const rest = detail.slice(first.length);
	if (rest.length === 0) return [`${prefix}${first}`, ""];

	let second = takeWidth(rest, secondLimit);
	if (second.length < rest.length) {
		// 省略号自己也占一列；先少取一个字符再补上
		second = `${takeWidth(rest, Math.max(0, secondLimit - 1))}…`;
	}
	return [`${prefix}${first}`, `${indent}${second}`];
}

/** 取显示宽度不超过 limit 的最长前缀，宽字符不会被切成半个。 */
function takeWidth(text: string, limit: number): string {
	let used = 0;
	let output = "";
	for (const char of text) {
		const charWidth = eastAsianWidth(char.codePointAt(0) ?? 0);
		if (used + charWidth > limit) break;
		used += charWidth;
		output += char;
	}
	return output;
}

/** 参数是格式化过的 JSON 或命令文本，压成一行才能放进固定高度的面板。 */
function compact(detail: string): string {
	const oneLine = detail.replace(/\s+/g, " ").trim();
	return oneLine.length > 0 ? oneLine : "(no arguments)";
}
