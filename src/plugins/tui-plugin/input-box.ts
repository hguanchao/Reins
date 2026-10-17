import {
	concat,
	lineWidth,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	type EditorRender,
	type Line,
	type Style,
} from "../../tui/index.ts";
import { OUTER_PAD } from "./layout.ts";
import { DIM, EDGE, EDGE_LIT, FAINT, TEXT } from "./theme.ts";

/**
 * 输入框。
 *
 * 上下各一条细线，左右缩进会话区外边距——输入框与会话条目画在同一个内容区里，而不是顶满
 * 屏幕；正文左右再各留两列。下边框右侧嵌入模型与审批方式。输入框是界面里最常停留的地方，
 * 这里只负责把编辑器的结果排成行，光标位置由调用方按同一组常量计算。
 */

/** 正文与左右边框之间的留白。 */
export const INPUT_PAD = 2;

/** 输入框整体与终端左右边缘的距离：与会话区最外圈一致。 */
const INPUT_MARGIN = OUTER_PAD;

/** 从终端左缘到输入正文的列数：左边距、左边框、左留白。 */
export const INPUT_LEFT = INPUT_MARGIN + 1 + INPUT_PAD;

/** 整屏宽度里被输入框框型占掉的列数：两侧外边距、两条竖线、两侧留白。 */
export const INPUT_CHROME = INPUT_MARGIN * 2 + INPUT_PAD * 2 + 2;

interface InputBoxOptions {
	readonly width: number;
	readonly editor: EditorRender;
	readonly focused: boolean;
	readonly model: string;
	readonly approval: string;
}

export function inputBoxRows(options: InputBoxOptions): readonly Line[] {
	const { width, editor, focused } = options;
	const border = focused ? EDGE_LIT : EDGE;
	const boxWidth = Math.max(1, width - INPUT_MARGIN * 2);
	const inner = Math.max(1, boxWidth - INPUT_PAD * 2 - 2);
	const base: Style = focused ? TEXT : { ...TEXT, dim: true };

	const text = editor.lines.map((line) =>
		concat(
			styled("│", border),
			plain(" ".repeat(INPUT_PAD)),
			padLine(mapLine(line, (style) => mergeStyles(base, style) ?? base), inner),
			plain(" ".repeat(INPUT_PAD)),
			styled("│", border),
		),
	);

	return [
		plain(""),
		row(INPUT_MARGIN, borderRow("╭", "─".repeat(Math.max(0, boxWidth - 2)), "╮", border)),
		...text.map((line) => row(INPUT_MARGIN, line)),
		row(INPUT_MARGIN, infoBorder(boxWidth, border, options.model, options.approval)),
	];
}

/** 行前的外边距：输入框不顶到屏幕边。 */
function row(pad: number, line: Line): Line {
	return pad <= 0 ? line : concat(plain(" ".repeat(pad)), line);
}

function borderRow(left: string, fill: string, right: string, border: Style): Line {
	return concat(styled(left, border), styled(fill, border), styled(right, border));
}

/** 下边框右侧嵌入模型与审批方式，和输入框的信息行一致。 */
function infoBorder(width: number, border: Style, model: string, approval: string): Line {
	const info = concat(
		styled(" ", FAINT),
		styled(model, DIM),
		styled(" · ", FAINT),
		styled(`approval=${approval}`, FAINT),
		styled(" ", FAINT),
	);
	const available = Math.max(0, width - 2);
	const infoWidth = lineWidth(info);
	if (infoWidth >= available) {
		return borderRow("╰", "─".repeat(available), "╯", border);
	}
	return concat(
		styled("╰", border),
		styled("─".repeat(available - infoWidth), border),
		info,
		styled("╯", border),
	);
}
