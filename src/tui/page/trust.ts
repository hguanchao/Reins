import { isAbsolute, relative } from "node:path";

import { displayWidth, fitToWidth, truncateToWidth, wrapWords } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 工作区信任页。
 *
 * 排成一块居中的对话框而不是铺满整屏：这是启动时的一次性确认，看完即走，居中比贴顶更容易
 * 被当成「先回答这一句」。列出具体路径而不是一句「项目配置」，因为按下信任之前得先知道
 * 自己在信任什么。
 */

/** 结论：记住信任、仅本次信任、不信任。 */
export type TrustAnswer = "trust" | "session" | "skip";

/** 对话框最宽到这里为止，再宽行长就不好扫读了。 */
const DIALOG_MAX_WIDTH = 76;
/** 对话框两侧至少留出的空白，窄终端下靠它保证内容不贴边。 */
const DIALOG_MARGIN = 2;

const TITLE = "Workspace trust";
const FILES_SECTION = "Files read under this trust";
const SKILLS_SECTION = "Skill directories scanned under this trust";
const INTRO = "This workspace ships files that change how Reins behaves.";
const TRUST_NOTE =
	"Trusting lets those files take effect. Reins only reads them; commands still run under the sandbox and the approval rules.";
const SKIP_NOTE = "Not trusting keeps the default: this workspace's configuration is ignored.";
const PENDING = "Recording the decision...";
const KEYS = "↑↓ move · enter confirm · esc do not trust";

export interface TrustPageInput {
	readonly root: string;
	readonly files: readonly string[];
	readonly skillDirectories: readonly string[];
	readonly selection: TrustAnswer;
	readonly pending: boolean;
}

const INDENT = "  ";
const BODY_INDENT = "    ";
const RESET = THEME.reset;
const MARKER = "› ";
const SLOT = "  ";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

const OPTIONS: readonly { readonly answer: TrustAnswer; readonly label: string }[] = [
	{ answer: "trust", label: "Trust this workspace" },
	{ answer: "session", label: "Trust for this session only" },
	{ answer: "skip", label: "Do not trust" },
];

/**
 * 整屏内容：对话框在给定区域里水平与垂直居中。
 *
 * 返回的行数恰好等于 height，内容放不下时从顶部开始并截断——此时对话框已经不是居中的了，
 * 但至少最要紧的标题与选项还在视野里。
 */
export function trustPageLines(input: TrustPageInput, width: number, height: number): readonly string[] {
	const columns = Math.max(1, width);
	const rows = Math.max(0, height);
	const dialogWidth = Math.max(1, Math.min(DIALOG_MAX_WIDTH, columns - DIALOG_MARGIN * 2));
	const content = dialogLines(input, dialogWidth);
	const block = [rule(dialogWidth), "", ...content, "", rule(dialogWidth)];

	const left = Math.max(0, Math.floor((columns - dialogWidth) / 2));
	const indent = " ".repeat(left);
	const top = Math.max(0, Math.floor((rows - block.length) / 2));
	const lines: string[] = Array.from({ length: rows }, () => "");
	for (let index = 0; index < block.length && top + index < rows; index += 1) {
		lines[top + index] = `${indent}${block[index]}`;
	}
	return lines;
}

/** 对话框正文：标题、资源清单、说明，最后是选项与按键提示。 */
function dialogLines(input: TrustPageInput, width: number): readonly string[] {
	const lines: string[] = [`${THEME.accent}${fitToWidth(TITLE, width)}${RESET}`, ""];
	lines.push(...paragraph(INTRO, width), "");
	if (input.files.length > 0) {
		lines.push(...section(FILES_SECTION, width));
		for (const file of input.files) lines.push(...pathLines(input.root, file, width));
		lines.push("");
	}
	if (input.skillDirectories.length > 0) {
		lines.push(...section(SKILLS_SECTION, width));
		for (const directory of input.skillDirectories) lines.push(...pathLines(input.root, directory, width));
		lines.push("");
	}
	lines.push(...paragraph(TRUST_NOTE, width), "", ...paragraph(SKIP_NOTE, width), "");
	lines.push(...optionLines(input, width));
	if (input.pending) lines.push("", `${THEME.textSecondary}${INDENT}${PENDING}${RESET}`);
	else lines.push("", `${THEME.textSubtle}${truncateToWidth(`${INDENT}${KEYS}`, width)}${RESET}`);
	return lines;
}

/** 选项列表：选中项用箭头标记并高亮，未选中项用同宽空白占位，切换时文字不左右跳。 */
function optionLines(input: TrustPageInput, width: number): readonly string[] {
	return OPTIONS.map((option) => {
		const head = option.answer === input.selection ? MARKER : SLOT;
		const label = `${head}${option.label}`;
		return option.answer === input.selection
			? `${BOLD}${THEME.accent}${truncateToWidth(label, width)}${BOLD_OFF}${THEME.textPrimary}`
			: `${THEME.textSubtle}${truncateToWidth(label, width)}${RESET}`;
	});
}

function rule(width: number): string {
	return `${THEME.border}${"─".repeat(Math.max(0, width))}${RESET}`;
}

/** 路径按工作区相对位置显示：绝对路径在信任页上一眼看不出是哪一个文件。 */
function displayPath(root: string, path: string): string {
	const relativePath = relative(root, path);
	return relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)
		? path
		: relativePath;
}

function section(title: string, width: number): readonly string[] {
	const text = truncateToWidth(title, Math.max(0, width - INDENT.length));
	return [`${THEME.textSubtle}${INDENT}${text}${RESET}`];
}

function pathLines(root: string, path: string, width: number): readonly string[] {
	const indent = BODY_INDENT.slice(0, width);
	const bodyWidth = Math.max(1, width - displayWidth(indent));
	return wrapWords(displayPath(root, path), bodyWidth).map(
		(line) => `${indent}${THEME.path}${line}${RESET}`,
	);
}

function paragraph(text: string, width: number): readonly string[] {
	const indent = INDENT.slice(0, width);
	const bodyWidth = Math.max(1, width - displayWidth(indent));
	return wrapWords(text, bodyWidth).map((line) => `${indent}${THEME.textSecondary}${line}${RESET}`);
}
