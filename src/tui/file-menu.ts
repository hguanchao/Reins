import { isImagePath } from "./image-attachments.ts";
import {
	ACCENT_COLOR,
	BOLD_OFF,
	MENU_MAX_VISIBLE,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	SUBTLE_COLOR,
	TEXT_COLOR,
	bottomBorder,
	keepVisible,
	menuHeight,
	topBorder,
} from "./menu-panel.ts";
import { characterWidth, displayWidth, fitToWidth } from "./text.ts";

/**
 * 输入框里的 `@` 文件补全。
 *
 * 这里只做「路径文本」的补全与排版：选中文本文件后把 `@相对路径` 写回输入框，文件内容仍由
 * 模型用读取工具获取。图片是例外——路径文本给不了模型视觉，选中后交给图片附件管线。
 */

/** 工作区文件清单；每次打开补全面板时重新取。 */
export interface FileSource {
	readonly list: () => readonly string[];
}

/** 光标所在的 `@` 路径片段。 */
export interface AtToken {
	/** `@` 的下标 */
	readonly start: number;
	/** 片段结束位置（下一个空白前） */
	readonly end: number;
	/** `@` 与光标之间的过滤词 */
	readonly query: string;
}

export interface FileMenuState {
	readonly items: readonly string[];
	readonly token: AtToken;
	cursor: number;
	scrollTop: number;
}

const FILE_MENU_MAX_VISIBLE = MENU_MAX_VISIBLE;
const MAX_RESULTS = 200;
const PREFIX_WIDTH = 3;
const IMAGE_BADGE = "  [image]";
const MIN_PATH_WIDTH = 12;

/** 面板高度与条数一致：超过一屏时只画窗口内的行。 */
export function fileMenuHeight(itemCount: number): number {
	return menuHeight(itemCount);
}

/**
 * 找出光标所在的 `@` 片段。
 *
 * 只认行首或空白之后的 `@`：`name@example.com` 这类普通文本不该弹出文件面板。光标可以停在
 * 片段中间，插入时整段替换。
 */
export function findAtToken(text: string, cursor: number): AtToken | undefined {
	const position = Math.min(Math.max(0, cursor), text.length);
	if (position === 0) return undefined;

	let start = position - 1;
	while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
	if (text[start] !== "@") return undefined;

	let end = position;
	while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
	return { start, end, query: text.slice(start + 1, position) };
}

/**
 * 过滤文件清单。
 *
 * 排在前面的依次是：文件名前缀命中、路径前缀命中、文件名包含、路径包含；同档按命中位置与
 * 路径长度排。文件名命中更接近「我记得这个文件名」的使用方式。
 */
export function filterFiles(
	files: readonly string[],
	query: string,
	limit = MAX_RESULTS,
): readonly string[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return files.slice(0, limit);

	const scored: {
		readonly path: string;
		readonly score: number;
		readonly index: number;
		readonly length: number;
	}[] = [];
	for (const path of files) {
		const lower = path.toLowerCase();
		const index = lower.indexOf(needle);
		if (index < 0) continue;
		const slash = lower.lastIndexOf("/");
		const name = slash < 0 ? lower : lower.slice(slash + 1);
		const score = name.startsWith(needle)
			? 0
			: lower.startsWith(needle)
				? 1
				: name.includes(needle)
					? 2
					: 3;
		scored.push({ path, score, index, length: path.length });
	}

	scored.sort(
		(left, right) =>
			left.score - right.score ||
			left.index - right.index ||
			left.length - right.length ||
			left.path.localeCompare(right.path),
	);
	return scored.slice(0, limit).map((entry) => entry.path);
}

/** 写回输入框的引用文本；含空格的路径加引号，免得不清楚路径到哪里结束。 */
export function formatFileReference(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export function renderFileMenu(width: number, state: FileMenuState): readonly string[] {
	const columns = Math.max(0, width);
	const items = state.items;
	const visibleCount = Math.min(items.length, FILE_MENU_MAX_VISIBLE);
	const top = keepVisible(state.scrollTop, state.cursor, items.length);
	const lines: string[] = [topBorder(columns, items.length)];

	for (let offset = 0; offset < visibleCount; offset += 1) {
		const item = items[top + offset];
		if (item === undefined) break;
		lines.push(row(columns, item, top + offset === state.cursor));
	}
	lines.push(bottomBorder(columns));
	return lines;
}

function row(width: number, path: string, selected: boolean): string {
	const columns = Math.max(0, width);
	const image = isImagePath(path);
	const badge = image ? IMAGE_BADGE : "";
	const showBadge = image && columns >= PREFIX_WIDTH + MIN_PATH_WIDTH + displayWidth(badge);
	const pathWidth = Math.max(
		1,
		columns - PREFIX_WIDTH - (showBadge ? displayWidth(badge) : 0),
	);
	const parts = pathParts(path, pathWidth);
	const pathText = parts.dir.length === 0
		? parts.name
		: `${parts.dir}/${parts.name}`;

	// 先按纯文本算宽度：颜色转义不能参与补齐，否则底色只铺到文字末尾
	const plain = `${selected ? " › " : "   "}${pathText}${showBadge ? badge : ""}`;
	const padding = " ".repeat(Math.max(0, columns - displayWidth(plain)));
	const prefix = selected ? ` ${ACCENT_COLOR}›${SELECTED_TEXT_COLOR} ` : "   ";
	const dir =
		parts.dir.length === 0
			? ""
			: `${selected ? SELECTED_TEXT_COLOR : MUTED_COLOR}${parts.dir}/`;
	const name = `${selected ? SELECTED_TEXT_COLOR : TEXT_COLOR}${parts.name}`;
	const badgeText = showBadge
		? `${selected ? SELECTED_TEXT_COLOR : SUBTLE_COLOR}${badge}`
		: "";
	const boldOff = selected ? BOLD_OFF : "";
	return `${PANEL_BG}${prefix}${dir}${name}${badgeText}${boldOff}${padding}${RESET}`;
}

/**
 * 路径拆成目录与文件名。
 *
 * 放不下时保留文件名，目录从左侧截断；把文件名截掉只剩一截目录，补全就失去意义了。
 */
function pathParts(path: string, width: number): { readonly dir: string; readonly name: string } {
	const slash = path.lastIndexOf("/");
	const dir = slash < 0 ? "" : path.slice(0, slash);
	const name = slash < 0 ? path : path.slice(slash + 1);
	const nameShown = fitToWidth(name, width);
	if (dir.length === 0) return { dir: "", name: nameShown };

	const nameWidth = displayWidth(nameShown);
	const room = width - nameWidth - 1;
	if (room <= 0) return { dir: "", name: nameShown };
	return { dir: tailToWidth(dir, room), name: nameShown };
}

/** 从字符串末尾截取到指定显示宽度；截断时在最前面补省略号。 */
function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;

	let tail = "";
	let used = 0;
	for (let index = text.length - 1; index >= 0; index -= 1) {
		const char = text[index] ?? "";
		const charWidth = characterWidth(char);
		if (used + charWidth > width - 1) break;
		tail = char + tail;
		used += charWidth;
	}
	return `…${tail}`;
}
