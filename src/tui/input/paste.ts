/**
 * 粘贴内容的显示方式。
 *
 * 多行或很大的文本直接铺进输入框会把草稿挤走，也会让光标移动变得难以控制。超过阈值时把它
 * 折成一个原子 chip，提交时再展开成完整内容；小段文本仍然直接内联，保持输入手感。
 */

/** 普通输入框折成 chip 的行数阈值。 */
export const PASTE_CHIP_MIN_LINES = 4;

/** 超过这个字节数就按大小折成 chip，行数不再是重点。 */
export const PASTE_CHIP_MAX_BYTES = 10_000;

/** 需要折成 chip 时返回显示标签，否则返回 undefined。 */
export function pasteChipLabel(text: string): string | undefined {
	const lines = pasteLineCount(text);
	const bytes = Buffer.byteLength(text, "utf8");
	if (lines < PASTE_CHIP_MIN_LINES && bytes <= PASTE_CHIP_MAX_BYTES) return undefined;

	if (bytes > PASTE_CHIP_MAX_BYTES) return `[Pasted: ${formatBytes(bytes)}]`;
	return `[Pasted: ${lines} line${lines === 1 ? "" : "s"}]`;
}

/**
 * 与 Rust 的 `str::lines()` 对齐的行数：末尾换行不额外算一行，「a\n\n」是两行。
 */
export function pasteLineCount(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines.length;
}

/** 十进制单位，和文件大小的常见写法一致。 */
function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1000) return `${Math.floor(bytes / 1000)} KB`;
	return `${bytes} bytes`;
}
