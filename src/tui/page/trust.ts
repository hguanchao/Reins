import { isAbsolute, relative } from "node:path";

import { displayWidth, fitToWidth, truncateToWidth, wrapWords } from "../render/text.ts";
import { THEME } from "../render/theme.ts";
import { pageTitle } from "./chrome.ts";

/**
 * 工作区信任页。
 *
 * 整屏铺满：标题钉在左上，正文与清单在中间逐行水平居中，底部分隔线固定不动。列出具体
 * 路径而不是一句「项目配置」，因为按下信任之前得先知道自己在信任什么。
 */

/** 结论：记住信任、仅本次信任、不信任。 */
export type TrustAnswer = "trust" | "session" | "skip";

/** 正文最宽到这里为止再居中：铺满整屏的长句一行读完很吃力。 */
const TEXT_MAX_WIDTH = 72;

const TITLE = "Reins — workspace trust";
const FILES_SECTION = "Files read under this trust";
const SKILLS_SECTION = "Skill directories scanned under this trust";
const INTRO = "This workspace ships files that change how Reins behaves.";
const TRUST_NOTE =
	"Trusting lets those files take effect. Reins only reads them; commands still run under the sandbox and the approval rules.";
const SKIP_NOTE = "Not trusting keeps the default: nothing from this workspace is loaded.";
const PENDING = "Recording the decision...";

export interface TrustPageInput {
	readonly root: string;
	readonly files: readonly string[];
	readonly skillDirectories: readonly string[];
	readonly selection: TrustAnswer;
	readonly pending: boolean;
}

const RESET = THEME.reset;
/** 选中项前的标记；未选中项用同宽空白占位，移动高亮时文字不左右跳。 */
const MARKER = "› ";
const SLOT = "  ";
const GAP = "   ";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

interface TrustOption {
	readonly answer: TrustAnswer;
	readonly label: string;
}

const FULL_LABELS: readonly TrustOption[] = [
	{ answer: "trust", label: "[y] Trust this workspace" },
	{ answer: "session", label: "[s] Trust for this session" },
	{ answer: "skip", label: "[n] Do not trust" },
];
/** 窄终端下的退路：宁可少几个字，也不要把按键前缀或「不信任」截掉。 */
const SHORT_LABELS: readonly TrustOption[] = [
	{ answer: "trust", label: "[y] Trust" },
	{ answer: "session", label: "[s] Session" },
	{ answer: "skip", label: "[n] Skip" },
];

/**
 * 整屏内容。
 *
 * 标题钉在首行，其余正文在「标题之下、底部分隔线之上」的区域里垂直居中；底部固定区
 * 占最后四行（分隔线、留白、居中的选项、留白），内容再长也只截正文，选项的位置不跳。
 */
export function trustPageLines(input: TrustPageInput, width: number, height: number): readonly string[] {
	const columns = Math.max(1, width);
	const rows = Math.max(0, height);
	const actions = actionLines(input, columns);
	const contentHeight = Math.max(0, rows - actions.length);

	const body = bodyLines(input, columns);
	const title = body[0] ?? "";
	const rest = body.slice(1);
	// 标题之下还有多少行可用；正文在这个范围内居中
	const available = Math.max(0, contentHeight - 1);
	const top = Math.max(0, Math.floor((available - rest.length) / 2));

	const lines: string[] = Array.from({ length: contentHeight }, () => "");
	if (contentHeight > 0) lines[0] = title;
	for (let index = 0; index < rest.length && 1 + top + index < contentHeight; index += 1) {
		lines[1 + top + index] = rest[index] ?? "";
	}
	return [...lines, ...actions].slice(0, rows);
}

/** 标题左对齐，其余内容逐行水平居中。 */
function bodyLines(input: TrustPageInput, width: number): readonly string[] {
	const lines: string[] = [pageTitle(TITLE, width), ""];
	const textWidth = Math.max(1, Math.min(TEXT_MAX_WIDTH, width));
	lines.push(...centered(INTRO, textWidth, width), "");
	if (input.files.length > 0) {
		lines.push(...centered(FILES_SECTION, textWidth, width, THEME.textSubtle));
		for (const file of input.files) lines.push(...centeredPath(input.root, file, textWidth, width));
		lines.push("");
	}
	if (input.skillDirectories.length > 0) {
		lines.push(...centered(SKILLS_SECTION, textWidth, width, THEME.textSubtle));
		for (const directory of input.skillDirectories) {
			lines.push(...centeredPath(input.root, directory, textWidth, width));
		}
		lines.push("");
	}
	lines.push(...centered(TRUST_NOTE, textWidth, width));
	lines.push("");
	lines.push(...centered(SKIP_NOTE, textWidth, width));
	return lines;
}

function actionLines(input: TrustPageInput, width: number): readonly string[] {
	const rule = `${THEME.border}${"─".repeat(width)}${RESET}`;
	// 分隔线与选项之间、选项与底边之间各留一行：选项在底部这块区域里上下居中
	if (input.pending) {
		// 录入结论时把选项行换成进行中的说明：避免连按回车重复提交
		return [rule, "", center(PENDING, width, THEME.textSecondary), ""];
	}
	return [rule, "", optionRow(input.selection, width), ""];
}

/** 三档横排、整体水平居中：当前档高亮加粗，拒绝档用失败色提示后果。 */
function optionRow(selection: TrustAnswer, width: number): string {
	const options = layoutOptions(width, selection);
	const plain = optionText(selection, options);
	if (displayWidth(plain) > width) return `${THEME.textSubtle}${truncateToWidth(plain, width)}${RESET}`;
	const styled = options
		.map((option) => {
			const head = option.answer === selection ? MARKER : SLOT;
			const label = `${head}${option.label}`;
			if (option.answer !== selection) return `${THEME.textSubtle}${label}${RESET}`;
			const color = option.answer === "skip" ? THEME.error : THEME.accent;
			return `${BOLD}${color}${label}${BOLD_OFF}${THEME.textPrimary}`;
		})
		.join(GAP);
	const pad = Math.max(0, Math.floor((width - displayWidth(plain)) / 2));
	return `${" ".repeat(pad)}${styled}`;
}

function layoutOptions(width: number, selection: TrustAnswer): readonly TrustOption[] {
	return displayWidth(optionText(selection, FULL_LABELS)) <= width ? FULL_LABELS : SHORT_LABELS;
}

function optionText(selection: TrustAnswer, options: readonly TrustOption[]): string {
	return options
		.map((option) => `${option.answer === selection ? MARKER : SLOT}${option.label}`)
		.join(GAP);
}

/** 文本按可用宽度折行后逐行居中；折行宽度与居中宽度分开算，免得长句横贯整屏。 */
function centered(
	text: string,
	textWidth: number,
	width: number,
	color: string = THEME.textSecondary,
): readonly string[] {
	return wrapWords(text, textWidth).map((line) => center(line, width, color));
}

function center(text: string, width: number, color: string): string {
	const visible = fitToWidth(text, width);
	const pad = Math.max(0, Math.floor((width - displayWidth(visible)) / 2));
	return `${" ".repeat(pad)}${color}${visible}${RESET}`;
}

function centeredPath(root: string, path: string, textWidth: number, width: number): readonly string[] {
	return wrapWords(displayPath(root, path), textWidth).map((line) => center(line, width, THEME.path));
}

/** 路径按工作区相对位置显示：绝对路径在信任页上一眼看不出是哪一个文件。 */
function displayPath(root: string, path: string): string {
	const relativePath = relative(root, path);
	return relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)
		? path
		: relativePath;
}
