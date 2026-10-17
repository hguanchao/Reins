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
import { DIM, EDGE, EDGE_LIT, FAINT, TEXT } from "./theme.ts";

/**
 * 输入框。
 *
 * 上下各一条细线，正文左右各留两列；下边框右侧嵌入模型与审批方式。输入框是界面里最常
 * 停留的地方，这里只负责把编辑器的结果排成行，光标位置由调用方按同一组常量计算。
 */

/** 正文与左右边框之间的留白。 */
export const INPUT_PAD = 2;

/** 左右留白加两条竖线。 */
export const INPUT_CHROME = INPUT_PAD * 2 + 2;

/** 从终端左缘到输入正文的列数：左边框加左留白。 */
export const INPUT_LEFT = INPUT_PAD + 1;

export interface InputBoxOptions {
	readonly width: number;
	readonly editor: EditorRender;
	readonly focused: boolean;
	readonly model: string;
	readonly approval: string;
}

export function inputBoxRows(options: InputBoxOptions): readonly Line[] {
	const { width, editor, focused } = options;
	const border = focused ? EDGE_LIT : EDGE;
	const inner = Math.max(1, width - INPUT_CHROME);
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
		concat(styled("╭", border), styled("─".repeat(Math.max(0, width - 2)), border), styled("╮", border)),
		...text,
		infoBorder(width, border, options.model, options.approval),
	];
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
		return concat(styled("╰", border), styled("─".repeat(available), border), styled("╯", border));
	}
	return concat(
		styled("╰", border),
		styled("─".repeat(available - infoWidth), border),
		info,
		styled("╯", border),
	);
}
