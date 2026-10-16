/**
 * 把编辑结果渲染成可读的差异。
 *
 * 每一处编辑已经知道自己在原文中的位置，所以不必做通用的行差异比较：直接按位置取出受影响的
 * 那几行，配上少量上下文就够了。这既省掉一整套差异算法，结果也更聚焦——使用者关心的是
 * 「这一处改成了什么」。
 */

/** 每处改动前后各显示多少行上下文。 */
const CONTEXT_LINES = 2;

/** 单个被替换区间的起止（字符偏移，基于原文）与替换内容。 */
export interface AppliedEdit {
	readonly start: number;
	readonly end: number;
	readonly newText: string;
}

/** 把字符偏移换算成 0 起的行号。 */
function lineIndexAt(text: string, offset: number): number {
	let line = 0;
	const limit = Math.min(offset, text.length);
	for (let index = 0; index < limit; index += 1) {
		if (text[index] === "\n") line += 1;
	}
	return line;
}

function linesOf(text: string): readonly string[] {
	return text.split("\n");
}

/**
 * 生成差异文本。
 *
 * edits 按字符偏移升序传入；updatedText 是全部编辑应用后的结果，用于取出「改成了什么」。
 * 每处改动的偏移在最终文本里的位置由前面几处改动的长度差累加得出。
 */
export function formatEditDiff(
	originalText: string,
	updatedText: string,
	edits: readonly AppliedEdit[],
): string {
	const originalLines = linesOf(originalText);
	const updatedLines = linesOf(updatedText);
	const blocks: string[] = [];
	let shift = 0;

	for (const edit of edits) {
		const originalStartLine = lineIndexAt(originalText, edit.start);
		const originalEndLine = lineIndexAt(originalText, Math.max(edit.start, edit.end - 1));

		const updatedStart = edit.start + shift;
		const updatedEndAnchor = updatedStart + Math.max(0, edit.newText.length - 1);
		const updatedStartLine = lineIndexAt(updatedText, updatedStart);
		const updatedEndLine = lineIndexAt(updatedText, updatedEndAnchor);

		const removedLines = edit.end > edit.start ? originalLines.slice(originalStartLine, originalEndLine + 1) : [];
		const addedLines = edit.newText.length > 0 ? updatedLines.slice(updatedStartLine, updatedEndLine + 1) : [];

		const contextBefore = originalLines.slice(Math.max(0, originalStartLine - CONTEXT_LINES), originalStartLine);
		const contextAfter = originalLines.slice(
			originalEndLine + 1,
			Math.min(originalLines.length, originalEndLine + 1 + CONTEXT_LINES),
		);

		const body = [
			...contextBefore.map((line) => `  ${line}`),
			...removedLines.map((line) => `- ${line}`),
			...addedLines.map((line) => `+ ${line}`),
			...contextAfter.map((line) => `  ${line}`),
		];
		blocks.push(`@@ 第 ${originalStartLine + 1} 行 @@\n${body.join("\n")}`);

		shift += edit.newText.length - (edit.end - edit.start);
	}

	return blocks.join("\n\n");
}
