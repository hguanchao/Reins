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
import { scrollbarCell } from "./scrollbar.ts";
import { DIM, EDGE, EDGE_LIT, FAINT, OK, SYSTEM, TEXT } from "./theme.ts";

/**
 * 输入框。
 *
 * 上下各一条细线，左右缩进会话区外边距——输入框与会话条目画在同一个内容区里，而不是顶满
 * 屏幕；正文左右再各留两列。下边框右侧嵌入模型、审批方式与多行标记。输入框是界面里最常停留的地方，
 * 这里只负责把编辑器的结果排成行，光标位置由调用方按同一组常量计算。
 */

/** 正文与右边框之间的留白；左边框与提示符直接相贴，不留格。 */
export const INPUT_PAD_RIGHT = 2;

/** 输入框整体与终端左右边缘的距离：与会话区最外圈一致。 */
const INPUT_MARGIN = OUTER_PAD;

/** 从终端左缘到输入正文的列数：左边距加左边框，没有额外缩进。 */
export const INPUT_LEFT = INPUT_MARGIN + 1;

/** 整屏宽度里被输入框框型占掉的列数：两侧外边距、两条竖线、右侧留白。 */
export const INPUT_CHROME = INPUT_MARGIN * 2 + 2 + INPUT_PAD_RIGHT;

interface InputBoxOptions {
	readonly width: number;
	readonly editor: EditorRender;
	readonly focused: boolean;
	readonly model: string;
	readonly approval: string;
	/** 草稿里有换行时在右下角标出来，提醒 Enter 会直接发送。 */
	readonly multiline?: boolean;
	/** 顶边框右侧的标题；目前用来标记暂存的草稿。 */
	readonly caption?: string;
}

export function inputBoxRows(options: InputBoxOptions): readonly Line[] {
	const { width, editor, focused } = options;
	const border = focused ? EDGE_LIT : EDGE;
	const boxWidth = Math.max(1, width - INPUT_MARGIN * 2);
	const inner = Math.max(1, boxWidth - 2 - INPUT_PAD_RIGHT);
	const base: Style = focused ? TEXT : { ...TEXT, dim: true };

	const scroll = editor.scroll;
	const showScroll = scroll !== undefined && scroll.total > editor.lines.length;
	const text = editor.lines.map((line, index) =>
		concat(
			styled("│", border),
			padLine(mapLine(line, (style) => mergeStyles(base, style) ?? base), inner),
			showScroll && scroll !== undefined
				? concat(plain(" "), [scrollbarCell(index, scroll.total, editor.lines.length, scroll.start)])
				: plain(" ".repeat(INPUT_PAD_RIGHT)),
			styled("│", border),
		),
	);

	return [
		row(INPUT_MARGIN, topBorder(boxWidth, border, options.caption)),
		...text.map((line) => row(INPUT_MARGIN, line)),
		row(INPUT_MARGIN, infoBorder(boxWidth, border, options.model, options.approval, options.multiline === true)),
	];
}

/** 行前的外边距：输入框不顶到屏幕边。 */
function row(pad: number, line: Line): Line {
	return pad <= 0 ? line : concat(plain(" ".repeat(pad)), line);
}

function borderRow(left: string, fill: string, right: string, border: Style): Line {
	return concat(styled(left, border), styled(fill, border), styled(right, border));
}

/** 顶边框：有标题时把它嵌在右侧，和参考实现的会话标题同一位置。 */
function topBorder(width: number, border: Style, caption: string | undefined): Line {
	const available = Math.max(0, width - 2);
	if (caption === undefined || caption.length === 0) {
		return borderRow("╭", "─".repeat(available), "╮", border);
	}
	const label = styled(` ${caption} `, DIM);
	const labelWidth = lineWidth(label);
	if (labelWidth + 2 > available) {
		return borderRow("╭", "─".repeat(available), "╮", border);
	}
	return concat(
		styled("╭", border),
		styled("─".repeat(available - labelWidth), border),
		label,
		styled("╮", border),
	);
}

/** 下边框右侧嵌入模型、审批方式与多行标记，和输入框的信息行一致。 */
/** 审批方式在下边框里写成人能读的标志，而不是配置键值。 */
function approvalFlag(approval: string): { readonly label: string; readonly style: Style } {
	switch (approval.toLowerCase()) {
		case "ask":
			return { label: "ask", style: OK };
		case "auto":
			return { label: "auto-review", style: SYSTEM };
		case "yolo":
			return { label: "always-approve", style: DIM };
		default:
			return { label: `approval=${approval}`, style: FAINT };
	}
}

function infoBorder(
	width: number,
	border: Style,
	model: string,
	approval: string,
	multiline: boolean,
): Line {
	const flag = approvalFlag(approval);
	const info = concat(
		styled(" ", FAINT),
		styled(model, DIM),
		styled(" · ", FAINT),
		styled(flag.label, flag.style),
		multiline ? styled("  multiline", DIM) : plain(""),
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
