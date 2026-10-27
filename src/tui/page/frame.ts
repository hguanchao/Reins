import type { CommandMenuItem } from "../panel/command-menu.ts";
import { padEnd } from "../panel/menu-panel.ts";
import { displayWidth, fitToWidth, wrapWords } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 整屏页。
 *
 * 帮助页、技能清单、MCP 连接清单共用一套排版：标题、若干分节、每节若干「名称 + 说明」的
 * 条目，再加一段脚注。三者都是「看一眼就关」的只读清单，没必要各写一套。
 *
 * 页面内容按宽度排好版交给调用方，滚动与视口裁切由 renderPage 负责——调用方不必知道内容有
 * 多长，只管把视口高度给它。
 */

export interface PageEntry {
	/** 左列的名称 */
	readonly name: string;
	readonly description: string;
	/** 另起一行的小字；用来放位置这类不该挤进说明列的信息 */
	readonly note?: string;
}

interface PageSection {
	readonly title: string;
	readonly entries: readonly PageEntry[];
	/** 一条都没有时顶替条目显示的一句话 */
	readonly empty?: string;
	/**
	 * 名称独占一行，说明与 note 缩进在下。
	 *
	 * 名字长、说明也长的清单用这个：表格布局靠名称列对齐，一旦名称被截断或说明折成好几行，
	 * 对齐反而帮倒忙——技能名是标识符，截成 `codebase-desi…` 就认不出来了。
	 */
	readonly layout?: "card";
}

/** 命令之外的固定内容。 */
const KEY_ENTRIES: readonly PageEntry[] = [
	{ name: "Enter", description: "Send the prompt; queue it while a turn is running" },
	{ name: "Tab", description: "Complete the selected item into the prompt" },
	{ name: "Shift+Tab", description: "Cycle the approval mode: ask, auto, yolo" },
	{ name: "Esc", description: "Close a menu or this page; deny an approval; interrupt and send the first queued message" },
	{ name: "Ctrl+C twice", description: "Exit the interface" },
	{ name: "Up / Down", description: "Prompt history, menu navigation, or page scrolling" },
	{ name: "Left / Right", description: "Move the prompt cursor or approval selection" },
	{ name: "Home / End", description: "Move to the start or end of the input line" },
	{ name: "Alt+Up", description: "Take the last queued message back into the prompt" },
	{ name: "Alt+Down", description: "Discard the last queued message" },
	{ name: "PgUp / PgDn", description: "Scroll the conversation or this page" },
	{ name: "Ctrl+Home/End", description: "Jump to the oldest or latest output" },
	{ name: "Ctrl+E", description: "Expand or collapse the latest thinking or tool group" },
	{ name: "Ctrl+O", description: "Show or hide the latest successful tool result" },
	{ name: "Ctrl+G", description: "View the latest long block (tool output, details, thinking, or prompt) full-screen" },
	{ name: "Ctrl/Alt+V", description: "Insert an image from the clipboard as [image: name]" },
	{ name: "Wheel / drag", description: "Scroll the conversation; drag the scrollbar" },
	{ name: "Double-click", description: "Expand or collapse thinking, tool groups, and tool details" },
	{ name: "y / a / n", description: "Allow once, always allow, or deny an approval" },
	{ name: "d", description: "Expand or hide approval details; arrow keys scroll them" },
	{ name: "@", description: "Complete a workspace file path; an image becomes an inline marker" },
];

const HELP_TITLE = "Reins — help";
const SKILLS_TITLE = "Reins — skills";
const MCPS_TITLE = "Reins — MCP servers";
const COMMANDS_TITLE = "Commands";
const KEYS_TITLE = "Keys";
const SERVERS_SECTION = "Servers";
const HELP_FOOTNOTE = "Run reins --help outside the interface for command-line options.";

/** 名称列最宽到这里为止，再长就截断，免得说明被挤得读不了。 */
const NAME_COLUMN_MAX = 14;
/** 名称右侧至少留这么多列给说明，否则说明另起一行。 */
const MIN_INLINE_DESCRIPTION = 8;
/** 名称列前缩进。 */
const ENTRY_INDENT = "  ";
/** 名称与说明之间留两列。 */
const ENTRY_GAP = "  ";
/** 卡片式的名称缩进。 */
const CARD_INDENT = "  ";
/** 卡片式的说明与 note 缩进：比名称再深两列，让层级一眼看得出来。 */
const CARD_BODY_INDENT = "    ";

const TITLE_COLOR = THEME.accent;
const SECTION_COLOR = THEME.textSubtle;
const NAME_COLOR = THEME.textPrimary;
const DESCRIPTION_COLOR = THEME.textSecondary;
/** 小字比说明还弱一档：它是补充信息，不该跟说明抢注意力 */
const NOTE_COLOR = THEME.textSubtle;
const RESET = THEME.reset;

/** 命令清单由调用方传进来，与补全面板共用同一份，新增命令时不会漏。 */
export function helpPageLines(width: number, commands: readonly CommandMenuItem[]): readonly string[] {
	return sectionPageLines(
		HELP_TITLE,
		[
			{
				title: COMMANDS_TITLE,
				entries: commands.map((command) => ({
					name: `/${command.name}`,
					description: command.description,
				})),
			},
			{ title: KEYS_TITLE, entries: KEY_ENTRIES },
		],
		[HELP_FOOTNOTE],
		width,
	);
}

/** 技能页的条目：多一个来源，用来分节。 */
export interface SkillPageEntry extends PageEntry {
	readonly scope: "user" | "project";
}

/** 技能清单；目录由调用方给出，脚注要照着它说清楚都扫了哪里。 */
export function skillsPageLines(
	width: number,
	skills: readonly SkillPageEntry[],
	directories: readonly string[],
): readonly string[] {
	const user = skills.filter((skill) => skill.scope === "user");
	const project = skills.filter((skill) => skill.scope === "project");
	const sections: PageSection[] =
		skills.length === 0
			? [{ title: "Skills", entries: [], empty: "No skills yet." }]
			: [
					...(user.length === 0 ? [] : [{ title: "User skills", entries: user, layout: "card" as const }]),
					...(project.length === 0
						? []
						: [{ title: "Project skills", entries: project, layout: "card" as const }]),
				];
	const footnotes = [
		...directories.map((directory) => `Looking in ${directory}`),
		"Changes take effect on the next turn.",
	];
	return sectionPageLines(SKILLS_TITLE, sections, footnotes, width);
}

/** MCP 连接清单；连不上的要把原因带出来，否则使用者只知道「没连上」。 */
export function mcpsPageLines(width: number, servers: readonly PageEntry[]): readonly string[] {
	return sectionPageLines(
		MCPS_TITLE,
		[
			{
				title: SERVERS_SECTION,
				entries: servers,
				empty: "No MCP servers configured.",
			},
		],
		["Add [mcp_servers.<name>] to config.toml to connect one."],
		width,
	);
}

/**
 * 排版后的完整内容。
 *
 * 每行都带好颜色，调用方直接拼进画面即可；宽度不够时说明文字换行，续行与首行说明对齐。
 */
function sectionPageLines(
	title: string,
	sections: readonly PageSection[],
	footnotes: readonly string[],
	width: number,
): readonly string[] {
	const columns = Math.max(0, width);
	const lines: string[] = [`${TITLE_COLOR}${fitToWidth(title, columns)}${RESET}`];
	for (const section of sections) {
		lines.push(...sectionLines(section, columns));
	}
	if (footnotes.length > 0) lines.push("");
	for (const footnote of footnotes) {
		lines.push(...wrapWords(footnote, columns).map((line) => `${DESCRIPTION_COLOR}${line}${RESET}`));
	}
	return lines;
}

/**
 * 取视口内的行。
 *
 * 返回的行数恰好等于 height，内容不足时补空行；scrollTop 超出范围时收敛到两端，因此内容
 * 整体放得下时它恒为 0。
 */
export function renderPage(
	lines: readonly string[],
	height: number,
	scrollTop: number,
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];

	const top = Math.min(Math.max(0, scrollTop), Math.max(0, lines.length - rows));
	return Array.from({ length: rows }, (_, index) => lines[top + index] ?? "");
}

/**
 * 带固定动作条的整屏页：正文按剩余高度滚动，动作条始终停在底部。
 *
 * 计划、检查点、作业与沙箱页共用同一套几何。高度分配只在这里算一次，动作条变化时
 * 各页不会各自偏移。
 */
export function framedPage(
	content: readonly string[],
	actions: readonly string[],
	height: number,
	scrollTop: number,
): readonly string[] {
	const rows = Math.max(0, height);
	const contentHeight = Math.max(0, rows - actions.length);
	return [...renderPage(content, contentHeight, scrollTop), ...actions].slice(0, rows);
}

function sectionLines(section: PageSection, width: number): readonly string[] {
	const lines: string[] = ["", `${SECTION_COLOR}${fitToWidth(section.title, width)}${RESET}`];
	if (section.entries.length === 0) {
		if (section.empty !== undefined) {
			lines.push(...wrapWords(section.empty, width).map((line) => `${DESCRIPTION_COLOR}${line}${RESET}`));
		}
		return lines;
	}

	if (section.layout === "card") {
		// 每条占三四行，不隔一行就会连成一片，看不出上一条到哪结束
		section.entries.forEach((entry, index) => {
			if (index > 0) lines.push("");
			lines.push(...cardLines(entry, width));
		});
		return lines;
	}

	const nameWidth = Math.min(
		NAME_COLUMN_MAX,
		Math.max(1, ...section.entries.map((entry) => displayWidth(entry.name))),
		// 名称列连同两侧间距必须留在终端宽度内，否则整行会被撑出去
		Math.max(1, width - displayWidth(ENTRY_INDENT) - displayWidth(ENTRY_GAP)),
	);
	for (const entry of section.entries) lines.push(...entryLines(entry, nameWidth, width));
	return lines;
}

/**
 * 卡片式条目：名称与来源同行，说明缩进在下。
 *
 * 名称不设列宽上限，只在放不下时按终端宽度截断——它是标识符，能完整显示就别动它。来源
 * （note）右对齐钉在名称行的行尾，弱色弱到不跟名称抢注意力；窄到放不下「名称 + 间隔 + 来源」
 * 时来源整段折到说明缩进里，宁可换位置也不截断。说明的第一句用正文亮色：一句话说清「这是
 * 什么」，后续的触发条件之类的长文退到说明色，扫读时先看到每个技能是什么。
 */
function cardLines(entry: PageEntry, width: number): readonly string[] {
	const indent = CARD_INDENT.slice(0, width);
	const bodyIndent = CARD_BODY_INDENT.slice(0, width);
	const bodyWidth = Math.max(1, width - displayWidth(bodyIndent));
	const nameWidth = Math.max(1, width - displayWidth(indent));

	const note = entry.note ?? "";
	// 名称与来源同行需要「至少一列间隔 + 来源」的余量；放不下时来源折到说明缩进里
	const inlineNote = note.length > 0 && displayWidth(entry.name) + NOTE_GAP + displayWidth(note) <= nameWidth;
	const head =
		note.length === 0
			? fitToWidth(entry.name, nameWidth)
			: inlineNote
				? `${fitToWidth(entry.name, nameWidth - displayWidth(note) - NOTE_GAP)}${NOTE_COLOR}${" ".repeat(
						Math.max(1, nameWidth - displayWidth(entry.name) - displayWidth(note)),
					)}${fitToWidth(note, nameWidth)}${RESET}`
				: fitToWidth(entry.name, nameWidth);
	const lines = [`${indent}${NAME_COLOR}${head}${RESET}`];

	if (!inlineNote && note.length > 0) {
		for (const line of wrapWords(note, bodyWidth)) {
			lines.push(`${bodyIndent}${NOTE_COLOR}${line}${RESET}`);
		}
	}

	if (entry.description.length > 0) {
		const [lead, ...rest] = splitFirstSentence(entry.description);
		// 首句用亮色单独折行；剩余部分换回说明色。首句自己超宽时照常折行，只是整段都是亮色
		for (const line of wrapWords(lead, bodyWidth)) {
			lines.push(`${bodyIndent}${NAME_COLOR}${line}${RESET}`);
		}
		const remainder = rest.join(" ");
		if (remainder.length > 0) {
			for (const line of wrapWords(remainder, bodyWidth)) {
				lines.push(`${bodyIndent}${DESCRIPTION_COLOR}${line}${RESET}`);
			}
		}
	}
	return lines;
}

/** 名称与行尾来源之间至少留出的间隔列数。 */
const NOTE_GAP = 2;

/** 把第一句与其余部分分开：以 `. `（或行尾的 `.`）为界；中文句号后没有空格，同样断句。 */
function splitFirstSentence(text: string): readonly [string, string[]] {
	const match = /^([^.!？?。]*[.!？?。])(.*)$/.exec(text);
	if (match === null) return [text, []];
	const lead = match[1] ?? text;
	const rest = (match[2] ?? "").trim();
	return [lead, rest.length === 0 ? [] : [rest]];
}

/** 名称列定宽；右侧放不下说明时说明另起一行，缩进退回名称列起点。 */
function entryLines(entry: PageEntry, nameWidth: number, width: number): readonly string[] {
	// 超长的名称不按列宽截断：名称是标识符，截成 `my-company-int…` 就认不出来了。让它这一行
	// 溢出列宽，说明照常另起一行，其余行的对齐不受影响；只在连整行都放不下时才截。
	const available = Math.max(1, width - displayWidth(ENTRY_INDENT) - displayWidth(ENTRY_GAP));
	const label =
		displayWidth(entry.name) > nameWidth ? fitToWidth(entry.name, available) : padEnd(entry.name, nameWidth);
	const head = `${ENTRY_INDENT}${label}${ENTRY_GAP}`;
	const headWidth = displayWidth(head);
	const noteLines =
		entry.note === undefined
			? []
			: wrapWords(entry.note, Math.max(1, width - displayWidth(ENTRY_INDENT))).map(
					(line) => `${ENTRY_INDENT}${NOTE_COLOR}${line}${RESET}`,
				);

	if (width - headWidth < MIN_INLINE_DESCRIPTION) {
		const indent = ENTRY_INDENT.slice(0, width);
		return [
			`${NAME_COLOR}${head}${RESET}`,
			...wrapWords(entry.description, Math.max(1, width - displayWidth(indent))).map(
				(line) => `${indent}${DESCRIPTION_COLOR}${line}${RESET}`,
			),
			...noteLines,
		];
	}

	const wrapped = wrapWords(entry.description, width - headWidth);
	const indent = " ".repeat(headWidth);
	return [
		...wrapped.map((line, index) =>
			index === 0
				? `${NAME_COLOR}${head}${DESCRIPTION_COLOR}${line}${RESET}`
				: `${indent}${DESCRIPTION_COLOR}${line}${RESET}`,
		),
		...noteLines,
	];
}
