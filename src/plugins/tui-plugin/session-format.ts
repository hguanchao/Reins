import type { CopyOutcome } from "../../tui/clipboard.ts";
import { pasteLineCount } from "../../tui/input/paste.ts";

/**
 * 会话区的提示文字。
 *
 * 复制结果要说明内容送到了哪里，悬停时间戳要展开完整日期；这两类文字都不带样式，方便在
 * 底部提示条里统一截断。
 */

/** 悬停时间戳时原地展开：24 小时制精确到秒，月份用缩写。 */
export function fullTimestamp(ms: number): string {
	const date = new Date(ms);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const pad = (value: number) => value.toString().padStart(2, "0");
	const hour = pad(date.getHours());
	const minute = pad(date.getMinutes());
	const second = pad(date.getSeconds());
	return `${hour}:${minute}:${second} | ${months[date.getMonth()]} ${date.getDate()}`;
}

/** 复制结果带上内容统计；提示语本身说明内容送到了哪里。 */
export function copyNotice(outcome: CopyOutcome, text: string): string {
	const chars = [...text].length;
	const lines = pasteLineCount(text);
	return `${outcome.message} (${chars} chars, ${lines} ${lines === 1 ? "line" : "lines"})`;
}
