import type { CopyOutcome } from "../../tui/clipboard.ts";
import { pasteLineCount } from "../../tui/input/paste.ts";

/**
 * 会话区的提示文字。
 *
 * 复制结果要说明内容送到了哪里，悬停时间戳要展开完整日期；这两类文字都不带样式，方便在
 * 底部提示条里统一截断。
 */

/** 悬停时间戳时展开成完整日期。 */
export function fullTimestamp(ms: number): string {
	const date = new Date(ms);
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	const hour = date.getHours() % 12 || 12;
	const minute = date.getMinutes().toString().padStart(2, "0");
	const suffix = date.getHours() < 12 ? "AM" : "PM";
	return `${year}-${month}-${day} ${hour}:${minute} ${suffix}`;
}

/** 复制结果带上内容统计；提示语本身说明内容送到了哪里。 */
export function copyNotice(outcome: CopyOutcome, text: string): string {
	const chars = [...text].length;
	const lines = pasteLineCount(text);
	return `${outcome.message} (${chars} chars, ${lines} ${lines === 1 ? "line" : "lines"})`;
}
