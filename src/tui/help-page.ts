import { eastAsianWidth } from "get-east-asian-width";

import type { CommandMenuItem } from "./command-menu.ts";
import { displayWidth, padEnd, truncate } from "./menu-panel.ts";
import { THEME } from "./theme.ts";

/**
 * 整屏帮助页。
 *
 * 命令行 --help 讲的是启动参数，这里讲界面里的斜杠命令与按键，受众不同，内容分开维护。命令
 * 清单由调用方传进来，与补全面板共用同一份，新增命令时不会漏；按键是界面自己定的，写在这里。
 *
 * 页面内容按宽度排好版交给调用方，滚动与视口裁切由 renderHelpPage 负责。
 */

interface HelpEntry {
	/** 左列的名称，按键或命令 */
	readonly name: string;
	readonly description: string;
}

/** 命令之外的固定内容。 */
const KEY_ENTRIES: readonly HelpEntry[] = [
	{ name: "Enter", description: "Send the prompt or confirm the selected action" },
	{ name: "Esc", description: "Close a menu or this page; deny an approval" },
	{ name: "Ctrl+C twice", description: "Exit the interface" },
	{ name: "Up / Down", description: "Prompt history, menu navigation, or help scrolling" },
	{ name: "Left / Right", description: "Move the prompt cursor or approval selection" },
	{ name: "Home / End", description: "Move to the start or end of the input line" },
	{ name: "PgUp / PgDn", description: "Scroll the conversation or this page" },
	{ name: "Ctrl+Home/End", description: "Jump to the oldest or latest output" },
	{ name: "Ctrl+E", description: "Expand or collapse the latest thinking or tool group" },
	{ name: "Ctrl+O", description: "Show or hide the latest successful tool result" },
	{ name: "Wheel / drag", description: "Scroll the conversation; drag the scrollbar" },
	{ name: "Double-click", description: "Expand or collapse thinking and tool groups" },
	{ name: "y / a / n", description: "Allow once, always allow, or deny an approval" },
];

const TITLE = "Reins — help";
const COMMANDS_TITLE = "Commands";
const KEYS_TITLE = "Keys";
const FOOTNOTE = "Run reins --help outside the interface for command-line options.";

/** 名称列最宽到这里为止，再长就截断，免得说明被挤得读不了。 */
const NAME_COLUMN_MAX = 14;
/** 名称右侧至少留这么多列给说明，否则说明另起一行。 */
const MIN_INLINE_DESCRIPTION = 8;
/** 名称列前缩进。 */
const ENTRY_INDENT = "  ";
/** 名称与说明之间留两列。 */
const ENTRY_GAP = "  ";

const TITLE_COLOR = THEME.accent;
const SECTION_COLOR = THEME.textSubtle;
const NAME_COLOR = THEME.textPrimary;
const DESCRIPTION_COLOR = THEME.textSecondary;
const RESET = THEME.reset;

/**
 * 排版后的完整内容。
 *
 * 每行都带好颜色，调用方直接拼进画面即可；宽度不够时说明文字换行，续行与首行说明对齐。
 */
export function helpPageLines(width: number, commands: readonly CommandMenuItem[]): readonly string[] {
	const columns = Math.max(0, width);
	const commandEntries: readonly HelpEntry[] = commands.map((command) => ({
		name: `/${command.name}`,
		description: command.description,
	}));
	const lines: string[] = [`${TITLE_COLOR}${truncate(TITLE, columns)}${RESET}`];
	lines.push(...sectionLines(COMMANDS_TITLE, commandEntries, columns));
	lines.push(...sectionLines(KEYS_TITLE, KEY_ENTRIES, columns));
	lines.push("");
	lines.push(...wrapText(FOOTNOTE, columns).map((line) => `${DESCRIPTION_COLOR}${line}${RESET}`));
	return lines;
}

/**
 * 取视口内的行。
 *
 * 返回的行数恰好等于 height，内容不足时补空行；scrollTop 超出范围时收敛到两端，因此内容
 * 整体放得下时它恒为 0。
 */
export function renderHelpPage(
	lines: readonly string[],
	height: number,
	scrollTop: number,
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];

	const top = Math.min(Math.max(0, scrollTop), Math.max(0, lines.length - rows));
	return Array.from({ length: rows }, (_, index) => lines[top + index] ?? "");
}

function sectionLines(
	title: string,
	entries: readonly HelpEntry[],
	width: number,
): readonly string[] {
	const nameWidth = Math.min(
		NAME_COLUMN_MAX,
		Math.max(1, ...entries.map((entry) => displayWidth(entry.name))),
		// 名称列连同两侧间距必须留在终端宽度内，否则整行会被撑出去
		Math.max(1, width - displayWidth(ENTRY_INDENT) - displayWidth(ENTRY_GAP)),
	);
	const lines: string[] = ["", `${SECTION_COLOR}${truncate(title, width)}${RESET}`];
	for (const entry of entries) lines.push(...entryLines(entry, nameWidth, width));
	return lines;
}

/** 名称列定宽；右侧放不下说明时说明另起一行，缩进退回名称列起点。 */
function entryLines(entry: HelpEntry, nameWidth: number, width: number): readonly string[] {
	const head = `${ENTRY_INDENT}${padEnd(entry.name, nameWidth)}${ENTRY_GAP}`;
	const headWidth = displayWidth(head);

	if (width - headWidth < MIN_INLINE_DESCRIPTION) {
		const indent = ENTRY_INDENT.slice(0, width);
		return [
			`${NAME_COLOR}${head}${RESET}`,
			...wrapText(entry.description, Math.max(1, width - displayWidth(indent))).map(
				(line) => `${indent}${DESCRIPTION_COLOR}${line}${RESET}`,
			),
		];
	}

	const wrapped = wrapText(entry.description, width - headWidth);
	const indent = " ".repeat(headWidth);
	return wrapped.map((line, index) =>
		index === 0
			? `${NAME_COLOR}${head}${DESCRIPTION_COLOR}${line}${RESET}`
			: `${indent}${DESCRIPTION_COLOR}${line}${RESET}`,
	);
}

/**
 * 按显示宽度折行。
 *
 * 优先在空格处断开，避免把英文单词切成两半；单个词本身就超过一行（以及中文这类没有空格
 * 分隔的文字）退回逐字符折行，宽字符不会被切成半个。
 */
function wrapText(text: string, limit: number): readonly string[] {
	if (limit <= 0) return [""];

	const lines: string[] = [];
	let line = "";
	let used = 0;
	const push = (): void => {
		lines.push(line);
		line = "";
		used = 0;
	};

	for (const word of text.split(" ")) {
		const wordWidth = displayWidth(word);
		const gap = line.length === 0 ? 0 : 1;
		if (used + gap + wordWidth <= limit) {
			line = line.length === 0 ? word : `${line} ${word}`;
			used += gap + wordWidth;
			continue;
		}

		if (line.length > 0) push();
		if (wordWidth <= limit) {
			line = word;
			used = wordWidth;
			continue;
		}

		for (const char of word) {
			const charWidth = eastAsianWidth(char.codePointAt(0) ?? 0);
			if (used + charWidth > limit && line.length > 0) push();
			line += char;
			used += charWidth;
		}
	}

	lines.push(line);
	return lines;
}
