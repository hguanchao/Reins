import type { PendingImage } from "#src/tui/image.ts";

/**
 * 输入框的撤销栈。
 *
 * 每次正文变化前把旧状态压栈，Ctrl+Z 弹出恢复。连打与连删的字符合并成一个撤销步：
 * 逐字符撤销一句话要按几十次，合并后一次退回到改动前的样子。粘贴、清空、历史召回
 * 这类多字符改动各自成步，不参与合并。栈深封顶，最老的记录先淘汰，长会话不囤内存。
 */

/** 一次编辑前的完整输入状态；图片随正文一起撤销，标记与数据不会脱节。 */
export interface InputSnapshot {
	readonly text: string;
	readonly cursor: number;
	readonly images: readonly PendingImage[];
}

export interface UndoEntry extends InputSnapshot {
	/** 压栈时刻（毫秒）；同向的单字符连击按时间窗合并。 */
	readonly at: number;
	readonly kind: "type" | "erase" | "single";
}

/** 连打合并的时间窗；超过就当作一次新的输入。 */
export const TYPE_RUN_WINDOW_MS = 600;
/** 栈深上限。 */
export const MAX_UNDO_ENTRIES = 100;

/**
 * 压入一次编辑的旧状态，返回新栈。
 *
 * 与栈顶同向（都是连打或都是连删）、又落在时间窗内的单字符编辑不新增条目：
 * 保留最初的状态，只刷新时间戳，这样一次 Ctrl+Z 退回整段连打。
 */
export function recordUndo(
	stack: readonly UndoEntry[],
	before: InputSnapshot,
	after: { readonly text: string; readonly cursor: number },
	now: number = Date.now(),
): readonly UndoEntry[] {
	const last = stack[stack.length - 1];
	const kind = editKind(before, after);
	if (
		last !== undefined &&
		kind !== "single" &&
		kind === last.kind &&
		now - last.at <= TYPE_RUN_WINDOW_MS
	) {
		return [...stack.slice(0, -1), { ...last, at: now }];
	}
	const next: readonly UndoEntry[] = [...stack, { ...before, at: now, kind }];
	return next.length > MAX_UNDO_ENTRIES ? next.slice(next.length - MAX_UNDO_ENTRIES) : next;
}

/** 单字符编辑归类（末尾追加、末尾删除）；其余改动一律按独立撤销步处理。 */
function editKind(
	before: InputSnapshot,
	after: { readonly text: string; readonly cursor: number },
): UndoEntry["kind"] {
	const delta = after.text.length - before.text.length;
	if (delta === 1 && after.cursor === after.text.length && after.text.startsWith(before.text)) {
		return "type";
	}
	if (delta === -1 && after.cursor === after.text.length && before.text.startsWith(after.text)) {
		return "erase";
	}
	return "single";
}

/** 弹出最近一步；空栈返回 undefined。 */
export function popUndo(
	stack: readonly UndoEntry[],
): { readonly snapshot: InputSnapshot; readonly rest: readonly UndoEntry[] } | undefined {
	const last = stack[stack.length - 1];
	if (last === undefined) return undefined;
	return { snapshot: last, rest: stack.slice(0, -1) };
}
