/**
 * 统一 diff 的解析。
 *
 * 渲染只要两样东西：逐行内容与行号。行号单列连续，不加号列、不画 hunk 头——增删行靠底色
 * 区分即可，多一列符号只会让代码列整体右移。解析失败（不是 diff）时整段退化为纯文本行，
 * 不吞内容。
 */

export type DiffRowKind = "add" | "del" | "ctx";

export interface DiffRow {
	readonly kind: DiffRowKind;
	readonly no: number;
	readonly text: string;
}

export interface DiffSection {
	readonly path: string | undefined;
	readonly rows: readonly DiffRow[];
	readonly added: number;
	readonly removed: number;
	/** 超出展示上限而未渲染的行数；0 表示全部显示 */
	readonly hidden: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER = /^### (.+)$/;

/** 一段 diff 可能含多个文件（edit 的 details.files 就是这种形状）。 */
export function parseDiff(text: string, maxRows = Number.POSITIVE_INFINITY): readonly DiffSection[] {
	const sections: DiffSection[] = [];
	let path: string | undefined;
	let rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	let added = 0;
	let removed = 0;
	let hidden = 0;
	let seenHunk = false;

	const flush = (): void => {
		if (rows.length === 0 && added === 0 && removed === 0) return;
		sections.push({ path, rows, added, removed, hidden });
		rows = [];
		added = 0;
		removed = 0;
		hidden = 0;
		seenHunk = false;
	};

	for (const raw of text.split("\n")) {
		const header = FILE_HEADER.exec(raw);
		if (header !== null) {
			flush();
			path = header[1]?.trim();
			continue;
		}
		if (raw.startsWith("diff --git") || raw.startsWith("+++ ") || raw.startsWith("--- ")) continue;
		const hunk = HUNK.exec(raw);
		if (hunk !== null) {
			oldNo = Number.parseInt(hunk[1] ?? "0", 10);
			newNo = Number.parseInt(hunk[2] ?? "0", 10);
			seenHunk = true;
			continue;
		}
		// 没有 hunk 头时仍按行首符号判断，行号从 1 起算
		if (!seenHunk) {
			seenHunk = true;
			oldNo = 1;
			newNo = 1;
		}
		if (raw.startsWith("+")) {
			added += 1;
			push({ kind: "add", no: newNo, text: raw.slice(1).replaceAll("\t", "    ") });
			newNo += 1;
			continue;
		}
		if (raw.startsWith("-")) {
			removed += 1;
			push({ kind: "del", no: oldNo, text: raw.slice(1).replaceAll("\t", "    ") });
			oldNo += 1;
			continue;
		}
		if (raw.startsWith("\\")) continue;
		push({ kind: "ctx", no: newNo, text: raw.replace(/^ /, "").replaceAll("\t", "    ") });
		oldNo += 1;
		newNo += 1;
	}
	flush();
	return sections;

	function push(row: DiffRow): void {
		if (rows.length >= maxRows) {
			hidden += 1;
			return;
		}
		rows.push(row);
	}
}

/** 增删行数；只统计内容行，文件头与 hunk 头不算。 */
export function diffStats(text: string | undefined): { readonly added: number; readonly removed: number } {
	if (text === undefined) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}
