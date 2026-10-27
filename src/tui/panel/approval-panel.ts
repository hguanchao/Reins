import type { ApprovalPrompt } from "../../permission/approval.ts";
import type { ApprovalAnswer } from "../../permission/policy.ts";
import { displayToolName, sanitizeLine } from "../../tools/describe.ts";
import {
	ACCENT_COLOR,
	BORDER_COLOR,
	PANEL_BG,
	RESET,
} from "./menu-panel.ts";
import { characterWidth, displayWidth, fitToWidth, sanitizeForDisplay, truncateToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 工具审批面板。
 *
 * 默认六行：标题边框、工具与核心摘要、摘要续行、导航提示、动作行、下边框。
 * 摘要只放核心命令或改动规模；更长的命令、diff 与文件内容按 d 展开成可滚动详情，
 * 高度封顶并给对话流留最小空间。这样卡片不会被长内容撑爆。
 */

/** 收起状态的高度：标题、两行摘要、提示、动作、下边框。 */
export const APPROVAL_PANEL_BASE_HEIGHT = 6;
/** 展开详情时至少给对话流留出的行数。 */
const APPROVAL_MIN_MAIN_ROWS = 3;

const TITLE = "Permission required";
const HINT = "←/→ select · Enter confirm · Esc deny";
/** 选中动作前的标记，与用户提示和工具调用保持一致。 */
const ACTION_MARKER = "› ";
/** 未选中的动作用同宽空白占位，移动高亮时文字不左右跳。 */
const ACTION_SLOT = " ".repeat(displayWidth(ACTION_MARKER));
/** 选中项加粗；之后必须关掉，否则后面的动作也会跟着变粗。 */
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

/**
 * 展开后的详情行（已按宽度折行）。
 *
 * 第一行是详情标题；后续是完整命令、diff 或文件内容。宽字符按显示列算，代码行在字符边界
 * 折行，续行与首行同缩进，避免把缩进吃掉。
 */
export function approvalPreviewLines(prompt: ApprovalPrompt, width: number): readonly string[] {
	if (prompt.preview === undefined) return [];
	const columns = Math.max(1, width);
	const bodyWidth = Math.max(1, columns - 2);
	const text = sanitizeForDisplay(
		prompt.preview.replace(/\r\n?/g, "\n").replace(/\t/g, "    "),
	);
	if (text.trim().length === 0) return [];

	const lines: string[] = [`  ${fitToWidth(prompt.previewLabel ?? "Details", bodyWidth)}`];
	for (const raw of text.split("\n")) {
		if (raw.length === 0) {
			lines.push("");
			continue;
		}
		if (displayWidth(raw) <= bodyWidth) {
			lines.push(`  ${raw}`);
			continue;
		}
		for (const chunk of wrapPreviewLine(raw, bodyWidth)) lines.push(`  ${chunk}`);
	}
	return lines;
}

/** 审批卡的高度：展开时最多占终端高度减三行，再长就靠滚动。 */
export function approvalPanelHeight(
	prompt: ApprovalPrompt,
	expanded: boolean,
	width: number,
	rows: number,
): number {
	if (!expanded) return APPROVAL_PANEL_BASE_HEIGHT;
	const preview = approvalPreviewLines(prompt, width).length;
	if (preview === 0) return APPROVAL_PANEL_BASE_HEIGHT;

	const maxHeight = Math.max(
		APPROVAL_PANEL_BASE_HEIGHT,
		Math.max(1, rows) - APPROVAL_MIN_MAIN_ROWS,
	);
	const capacity = Math.max(0, maxHeight - APPROVAL_PANEL_BASE_HEIGHT);
	return APPROVAL_PANEL_BASE_HEIGHT + Math.min(preview, capacity);
}

/** 详情还能往下滚多少行；输入处理用它收紧滚动位置。 */
export function approvalPreviewScrollLimit(
	prompt: ApprovalPrompt,
	expanded: boolean,
	width: number,
	rows: number,
): number {
	const total = approvalPreviewLines(prompt, width).length;
	const visible = approvalPanelHeight(prompt, expanded, width, rows) - APPROVAL_PANEL_BASE_HEIGHT;
	return Math.max(0, total - visible);
}

export function renderApprovalPanel(
	width: number,
	rows: number,
	prompt: ApprovalPrompt,
	selected: ApprovalAnswer = "once",
	expanded = false,
	scrollTop = 0,
): readonly string[] {
	const columns = Math.max(1, width);
	const height = approvalPanelHeight(prompt, expanded, columns, rows);
	const detail = detailLines(columns, prompt);
	const actions = actionRow(columns, prompt, selected);

	const lines: string[] = [
		titleBorder(columns, prompt.risk),
		toolLine(columns, prompt, detail),
		continuationLine(columns, prompt, detail),
	];

	const capacity = height - APPROVAL_PANEL_BASE_HEIGHT;
	if (capacity > 0) {
		const preview = approvalPreviewLines(prompt, columns);
		const top = Math.min(Math.max(0, scrollTop), Math.max(0, preview.length - capacity));
		for (let index = 0; index < capacity; index += 1) {
			lines.push(previewLine(columns, preview[top + index]));
		}
	}

	const canExpand = approvalPanelHeight(prompt, true, columns, rows) > APPROVAL_PANEL_BASE_HEIGHT;
	lines.push(hintLine(columns, canExpand, expanded));
	lines.push(styledContent(`  ${actions.styled}`, 2 + actions.width, columns));
	lines.push(bottomBorder(columns));
	return lines;
}

/** 风险词放在标题最前面：窄屏截断时先保它。 */
function titleBorder(width: number, risk: string): string {
	const label = risk.length === 0 ? ` ${TITLE} ` : ` ${risk} · ${TITLE} `;
	if (displayWidth(label) < width) {
		const pad = width - displayWidth(label);
		const left = Math.floor(pad / 2);
		return `${BORDER_COLOR}${"─".repeat(left)}${riskColor(risk)}${label}${BORDER_COLOR}${"─".repeat(pad - left)}${RESET}`;
	}
	if (risk.length === 0) return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;

	// 标题放不下时只保留风险词；连风险词都放不下才退回纯边框
	const compact = ` ${fitToWidth(risk, Math.max(0, width - 2))} `;
	if (displayWidth(compact) >= width) return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;
	const pad = width - displayWidth(compact);
	const left = Math.floor(pad / 2);
	return `${BORDER_COLOR}${"─".repeat(left)}${riskColor(risk)}${compact}${BORDER_COLOR}${"─".repeat(pad - left)}${RESET}`;
}

function riskColor(risk: string): string {
	return risk === "destructive" ? THEME.error : THEME.warning;
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

/** 导航提示：y/a/n 已经写在动作里，这里补上左右与确认、拒绝键，以及详情开关。 */
function hintLine(width: number, hasDetails: boolean, expanded: boolean): string {
	const suffix = hasDetails ? (expanded ? " · d hide · ↑/↓ scroll" : " · d details") : "";
	const full = `  ${HINT}${suffix}`;
	// 窄屏优先保住 d 提示，否则详情入口会被整段截掉
	const compact = hasDetails ? `  d ${expanded ? "hide · ↑/↓ scroll" : "details"} · ←/→ · Enter · Esc` : full;
	const text = truncateToWidth(displayWidth(full) <= width ? full : compact, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
	return `${PANEL_BG}${THEME.textSubtle}${text}${padding}${RESET}`;
}

function detailColor(prompt: ApprovalPrompt): string {
	return prompt.tool === "edit" || prompt.tool === "write" ? THEME.path : THEME.textPrimary;
}

/** 把工具展示名与核心摘要铺成最多两行；第二行仍放不下就在末尾省略。 */
function detailLines(width: number, prompt: ApprovalPrompt): DetailLines {
	// 工具名与摘要都来自模型，可能带转义序列：先清理再排版，否则面板内容可被伪造。
	// 工具名过长时同样要截断，否则 prefixWidth 会超过面板宽度、整行溢出。
	const maxTool = Math.max(1, Math.floor(width / 3));
	const tool = fitToWidth(sanitizeLine(displayToolName(prompt.tool)), maxTool);
	const prefixWidth = Math.min(width - 1, 2 + displayWidth(tool) + 2);
	const limit = Math.max(1, width - prefixWidth);
	const detail = compact(prompt.summary ?? prompt.detail);

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

/** 详情区的单行：diff 的增删用成功/失败色，其余用正文副色。 */
function previewLine(width: number, line: string | undefined): string {
	if (line === undefined) return `${PANEL_BG}${" ".repeat(width)}${RESET}`;
	const head = line.trimStart();
	const color =
		head.startsWith("+ ")
			? THEME.success
			: head.startsWith("- ")
				? THEME.error
				: head.startsWith("@@")
					? THEME.textSubtle
					: THEME.textSecondary;
	const padding = " ".repeat(Math.max(0, width - displayWidth(line)));
	return `${PANEL_BG}${color}${line}${padding}${RESET}`;
}

/** 代码行按字符边界折行，保留缩进；与按词折行的说明文字不同。 */
function wrapPreviewLine(text: string, width: number): readonly string[] {
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const char of text) {
		const charWidth = characterWidth(char);
		if (used + charWidth > width && line.length > 0) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += char;
		used += charWidth;
	}
	lines.push(line);
	return lines;
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
	const oneLine = sanitizeLine(detail).replace(/\s+/g, " ").trim();
	return oneLine.length > 0 ? oneLine : "(no arguments)";
}
