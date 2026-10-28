import { isAbsolute, relative } from "node:path";

import { displayWidth, truncateToWidth, wrapWords } from "../render/text.ts";
import { THEME } from "../render/theme.ts";
import { pageTitle } from "./chrome.ts";

/**
 * 工作区信任页。
 *
 * 这是界面里唯一一个「作出结论之前不能继续」的页面：它挡在对话流前面，把会因为这次信任
 * 而生效的东西逐条摆出来。列出具体路径而不是一句「项目配置」，是因为按信任之前得先知道
 * 自己在信任什么。
 */

const TITLE = "Reins — workspace trust";
const FILES_SECTION = "Files read under this trust";
const SKILLS_SECTION = "Skill directories scanned under this trust";
const INTRO = "This workspace ships files that change how Reins behaves.";
const TRUST_NOTE =
	"Trusting lets those files take effect. Reins only reads them; commands still run under the sandbox and the approval rules.";
const SKIP_NOTE = "Skipping keeps the default: this workspace's configuration is ignored for this run.";
const PENDING = "Recording the decision...";

/** 动作行的选中项：授予信任，或本次跳过。 */
export type TrustSelection = "trust" | "skip";

export interface TrustPageInput {
	readonly root: string;
	readonly files: readonly string[];
	readonly skillDirectories: readonly string[];
	readonly selection: TrustSelection;
}

const INDENT = "  ";
const BODY_INDENT = "    ";
const RESET = THEME.reset;

export function trustPageLines(input: TrustPageInput, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const lines: string[] = [pageTitle(TITLE, columns), ""];

	lines.push(...paragraph(INTRO, columns));
	lines.push("");
	if (input.files.length > 0) {
		lines.push(...section(FILES_SECTION, columns));
		for (const file of input.files) lines.push(...pathLines(input.root, file, columns));
		lines.push("");
	}
	if (input.skillDirectories.length > 0) {
		lines.push(...section(SKILLS_SECTION, columns));
		for (const directory of input.skillDirectories) lines.push(...pathLines(input.root, directory, columns));
		lines.push("");
	}
	lines.push(...paragraph(TRUST_NOTE, columns));
	lines.push("");
	lines.push(...paragraph(SKIP_NOTE, columns));
	return lines;
}

/**
 * 底部动作条。
 *
 * 高亮跟着左右键走，回车执行高亮项；录入结论期间换一句进行中的说明，避免连按回车重复提交。
 */
export function trustActionLines(
	width: number,
	selection: TrustSelection,
	pending: boolean,
): readonly string[] {
	const columns = Math.max(0, width);
	if (columns === 0) return ["", ""];
	const rule = `${THEME.border}${"─".repeat(columns)}${RESET}`;
	if (pending) {
		return [rule, `${THEME.textSecondary}${truncateToWidth(`${INDENT}${PENDING}`, columns)}${RESET}`];
	}

	const options = actions(columns, selection);
	if (options === undefined) {
		return [rule, `${THEME.textSecondary}${truncateToWidth(actionText(selection, FULL_LABELS), columns)}${RESET}`];
	}
	const plain = actionText(selection, options);
	const padding = " ".repeat(Math.max(0, columns - displayWidth(plain)));
	const styled = options
		.map((option) => {
			const head = option.action === selection ? MARKER : SLOT;
			const label = `${head}${option.label}`;
			return option.action === selection
				? `${BOLD}${THEME.accent}${label}${BOLD_OFF}${THEME.textPrimary}`
				: `${THEME.textSubtle}${label}${RESET}`;
		})
		.join(GAP);
	return [rule, `${styled}${padding}`];
}

interface TrustAction {
	readonly action: TrustSelection;
	readonly label: string;
}

/** 完整文案放不下时退到只留结论词：宁可少几个字，也不要把「跳过」截成半截。 */
const FULL_LABELS: readonly TrustAction[] = [
	{ action: "trust", label: "[y] trust this workspace" },
	{ action: "skip", label: "[n] not now" },
];
const COMPACT_LABELS: readonly TrustAction[] = [
	{ action: "trust", label: "[y] trust" },
	{ action: "skip", label: "[n] skip" },
];

/** 当前宽度下能完整放下的那组文案；都放不下时交给调用方截断。 */
function actions(width: number, selection: TrustSelection): readonly TrustAction[] | undefined {
	for (const labels of [FULL_LABELS, COMPACT_LABELS]) {
		if (displayWidth(actionText(selection, labels)) <= width) return labels;
	}
	return undefined;
}

/** 动作行的纯文本：选中项带标记、未选中项留同宽空白，宽度按这份算。 */
function actionText(selection: TrustSelection, options: readonly TrustAction[]): string {
	return options
		.map((option) => `${option.action === selection ? MARKER : SLOT}${option.label}`)
		.join(GAP);
}

/** 选中项前的标记；未选中项用同宽空白占位，切换高亮时文字不左右跳。 */
const MARKER = "› ";
const SLOT = "  ";
const GAP = "   ";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

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
