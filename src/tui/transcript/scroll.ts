import {
	HEADER_GAP_LINES,
	RESET,
	SCROLLBAR_COLOR,
	SCROLLBAR_THUMB,
	SCROLLBAR_TRACK,
} from "./style.ts";
import type { PromptRange, TranscriptView } from "./types.ts";

/**
 * 可滚动的总行数。
 *
 * 底部留白让最后一条提示能停在视口顶部（发送后的 page flip），但它只在内容已经超过一屏时
 * 才有意义。内容不足一屏还留白，滚轮就能滚进一片空白，而滚动条与置底按钮也会跟着指向并不
 * 存在的东西——那正是「没内容却提示回到底部」的来源。
 *
 * 滚动、滚动条、置底按钮、拖动都必须用这一个函数，四处各算一遍迟早对不上。
 */
export function scrollableLines(total: number, lastPromptStart: number, rows: number): number {
	if (total <= rows) return total;
	return Math.max(total, lastPromptStart + rows);
}

export function lineIndexAtRow(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): number | undefined {
	const rows = Math.max(0, height);
	if (rows === 0 || row < 1 || row > rows) return undefined;

	const { top } = scrollState(view, rows, scrollTop);
	const indexes = visibleIndexes(view, rows, top);
	return indexes[row - 1];
}

export function scrollState(
	view: TranscriptView,
	rows: number,
	requestedTop: number,
): { readonly top: number } {
	const total = view.lines.length;
	const lastPromptStart = view.prompts.at(-1)?.start ?? 0;
	// 与 measureTranscriptView 用同一份留白规则，否则渲染窗口和滚动条会各说各话
	const scrollLines = scrollableLines(total, lastPromptStart, rows);
	const maxScroll = Math.max(0, scrollLines - rows);
	return { top: Math.min(Math.max(0, requestedTop), maxScroll) };
}

export function visibleIndexes(
	view: TranscriptView,
	rows: number,
	top: number,
): readonly number[] {
	const prompt = pinnedPrompt(view.prompts, top);
	if (prompt !== undefined && top > prompt.start) {
		const full = prompt.height + HEADER_GAP_LINES;
		// 下一条提示逼近时，吸顶块从自己的顶部收起，把下一个提示块完整让出来；
		// 提示前固定留的那行空行留在正文里，块与块之间才不会贴在一起
		const next = view.prompts.find((item) => item.start > prompt.start);
		const budget = next === undefined ? full : next.start - top - 1;
		const headerCount = Math.min(rows, Math.min(full, Math.max(0, budget)));
		if (headerCount > 0) {
			const header = headerIndexes(prompt, headerCount);
			// header 盖住视口顶部；正文接着被盖住的行继续，滚动才始终有位移
			const contentTop = top + headerCount;

			const contentHeight = Math.max(0, rows - headerCount);
			const content = Array.from({ length: contentHeight }, (_, index) => contentTop + index);
			return [...header, ...content];
		}
	}
	return Array.from({ length: rows }, (_, index) => top + index);
}

/**
 * 吸顶块显示提示的哪几行。
 *
 * 满高时连同提示后的空行一起显示；被下一条提示顶出去时只保留提示块末尾的几行，
 * 空行留在正文里给下一个提示块做间隔。
 */
function headerIndexes(prompt: PromptRange, count: number): readonly number[] {
	const start =
		count === prompt.height + HEADER_GAP_LINES
			? prompt.start
			: prompt.start + prompt.height - count;
	return Array.from({ length: count }, (_, index) => start + index);
}

export function pinnedPrompt(prompts: readonly PromptRange[], top: number): PromptRange | undefined {
	let found: PromptRange | undefined;
	for (const prompt of prompts) {
		if (prompt.start <= top) found = prompt;
		else break;
	}
	return found;
}

/**
 * 滚动条那一列。
 *
 * 调用方除了把它拼在每行末尾，还要在画完内容之后按自己的行列位置重画一遍：一行是否被终端
 * 换行取决于终端把每个字符算几列（不同终端对歧义宽度字符的处理并不一致），跟着内容一起画的
 * 那一列会被带到别处。单独重画时它只依赖自己的行列，内容怎么换行都不影响。
 */
export function scrollbarColumn(height: number, scrollLines: number, top: number): readonly string[] {
	// 内容没有超出视口时没有可滚动的东西，整列留空，不画轨道和滑块
	if (scrollLines <= height) return Array.from({ length: height }, () => " ");

	const thumb = scrollbarThumb(height, scrollLines);
	const maxScroll = Math.max(1, scrollLines - height);
	const thumbTop = Math.round((Math.min(Math.max(0, top), maxScroll) / maxScroll) * thumb.maxTop);

	return Array.from({ length: height }, (_, row) => {
		const char = row >= thumbTop && row < thumbTop + thumb.height ? SCROLLBAR_THUMB : SCROLLBAR_TRACK;
		return `${SCROLLBAR_COLOR}${char}${RESET}`;
	});
}

/**
 * 滑块的高度与可移动范围。
 *
 * 绘制与拖动共用这一份几何。两边各算一遍的话，拖到哪滑块都不在光标下。
 */
export function scrollbarThumb(
	height: number,
	scrollLines: number,
): { readonly height: number; readonly maxTop: number } {
	if (scrollLines <= height) return { height, maxTop: 0 };
	const size = Math.min(height, Math.max(1, Math.floor((height * height) / Math.max(1, scrollLines))));
	return { height: size, maxTop: Math.max(0, height - size) };
}

/**
 * 拖动滚动条：让滑块中心落在光标那一行，再换算成 scrollTop。
 *
 * 先按滑块自己的行坐标求出它该停在哪，最后才换算成滚动量。不能直接拿整列高度线性换算——
 * 滑块只占其中一段、也只能移动一段，按整列算的话光标与滑块对不上。
 */
export function scrollTopForRow(row: number, height: number, maxScroll: number): number {
	if (maxScroll <= 0 || height <= 1) return 0;

	const thumb = scrollbarThumb(height, maxScroll + height);
	if (thumb.maxTop === 0) return 0;

	const top = Math.min(Math.max(0, row - 1 - Math.floor(thumb.height / 2)), thumb.maxTop);
	return Math.round((top / thumb.maxTop) * maxScroll);
}
