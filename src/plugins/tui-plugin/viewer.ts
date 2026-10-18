import { stripVTControlCharacters } from "node:util";

import {
	concat,
	lineWidth,
	padLine,
	plain,
	styled,
	truncateLine,
	wrapLine,
	type Line,
} from "../../tui/index.ts";
import { OUTER_PAD } from "./layout.ts";
import { EDGE, TEXT } from "./theme.ts";

/**
 * 块的全屏查看器。
 *
 * 选中块按 `v` 后，会话区换成一块可滚动的阅读面板。内容按当前宽度重新折行，工具输出里的
 * 颜色转义先清掉——这里要的是完整、稳定的阅读，不是再执行一遍终端排版。
 */

export interface ViewerState {
	readonly width: number;
	readonly rows: number;
	readonly title: string;
	readonly text: string;
	readonly scroll: number;
}

export interface ViewerRender {
	readonly lines: readonly Line[];
	readonly maxScroll: number;
}

export function viewerRows(state: ViewerState): ViewerRender {
	const text = stripVTControlCharacters(state.text.replaceAll("\r\n", "\n").replaceAll("\r", ""));
	const hasBox = state.rows >= 4;
	const boxWidth = Math.max(20, state.width - OUTER_PAD * 2);
	const inner = hasBox ? Math.max(1, boxWidth - 4) : Math.max(1, state.width - OUTER_PAD * 2);
	const wrapped = wrapLine(styled(text, TEXT), { width: inner });
	const contentRows = hasBox ? state.rows - 2 : state.rows;
	const maxScroll = Math.max(0, wrapped.length - contentRows);
	const scroll = Math.max(0, Math.min(maxScroll, state.scroll));
	const visible = wrapped.slice(scroll, scroll + contentRows);
	while (visible.length < contentRows) visible.push([]);

	if (!hasBox) {
		return {
			lines: visible.map((line) =>
				concat(plain(" ".repeat(OUTER_PAD)), padLine(line, inner), plain(" ".repeat(OUTER_PAD))),
			),
			maxScroll,
		};
	}

	const position =
		wrapped.length > contentRows
			? ` · ${scroll + 1}-${Math.min(wrapped.length, scroll + contentRows)}/${wrapped.length}`
			: "";
	const title = truncateLine(styled(` ${state.title}${position} `, { bold: true, color: TEXT.color }), boxWidth - 4);
	const fill = Math.max(0, boxWidth - 2 - lineWidth(title));
	const margin = plain(" ".repeat(Math.max(0, Math.floor((state.width - boxWidth) / 2))));

	const body = visible.map((line) =>
		concat(
			margin,
			styled("│", EDGE),
			plain(" "),
			padLine(line, inner),
			plain(" "),
			styled("│", EDGE),
		),
	);

	return {
		lines: [
			concat(margin, styled("╭", EDGE), title, styled("─".repeat(fill), EDGE), styled("╮", EDGE)),
			...body,
			concat(margin, styled("╰", EDGE), styled("─".repeat(boxWidth - 2), EDGE), styled("╯", EDGE)),
		],
		maxScroll,
	};
}
