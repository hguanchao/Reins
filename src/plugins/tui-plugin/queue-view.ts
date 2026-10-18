import { concat, plain, styled, truncateLine, type Line } from "../../tui/index.ts";
import { pasteLineCount } from "../../tui/input/paste.ts";
import { OUTER_PAD } from "./layout.ts";
import { DIM, FAINT, TEXT } from "./theme.ts";

/**
 * 运行中排队的后续消息。
 *
 * 一轮还没跑完时提交的内容不会丢，也不会打断当前回合：它们按顺序排在输入框上方，等这一轮
 * 结束后自动接着跑。行数封顶，超出时最后一行说明还剩多少条。
 */

export const MAX_QUEUE_ROWS = 3;

export function queueRows(queue: readonly string[], width: number): readonly Line[] {
	if (queue.length === 0) return [];

	const shown = queue.length > MAX_QUEUE_ROWS ? queue.slice(0, MAX_QUEUE_ROWS - 1) : queue;
	const rows = shown.map((text, index) => queueLine(index + 1, text, width));
	if (queue.length > shown.length) {
		rows.push(
			concat(
				plain(" ".repeat(OUTER_PAD + 3)),
				styled(`… ${queue.length - shown.length} more queued`, DIM),
			),
		);
	}
	return rows;
}

function queueLine(position: number, text: string, width: number): Line {
	const lines = text.split("\n");
	const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
	const total = pasteLineCount(text);
	const suffix = total > 1 ? ` (+${total - 1} line${total - 1 === 1 ? "" : "s"})` : "";
	const content = concat(
		styled(`#${position} `, FAINT),
		styled(first, TEXT),
		styled(suffix, DIM),
	);
	return concat(plain(" ".repeat(OUTER_PAD)), truncateLine(content, Math.max(1, width - OUTER_PAD)));
}
