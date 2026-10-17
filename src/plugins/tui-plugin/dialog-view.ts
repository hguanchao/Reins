import {
	concat,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	truncateLine,
	wrapLine,
	type Line,
	type Style,
} from "../../tui/index.ts";
import { DIALOG_OPTIONS, type ConfirmDialog } from "./dialog.ts";
import { toolSummary } from "./transcript-format.ts";
import { ACCENT, BAND, DIM, SELECT_BG, TEXT, TITLE } from "./theme.ts";

/**
 * 权限弹窗。
 *
 * 弹窗替换输入区而不是盖在主区上：问题、命令预览与纵向选项都排在同一条左竖线里，后面的
 * 会话仍然完整可见。选项用 `(●)` / `(○)` 标出当前焦点，避免依赖背景色。
 */

/** 弹窗正文相对终端左缘的留白：竖线、两列内边距与右侧两列。 */
const CONTENT_INSET = 5;

export function panelRows(
	width: number,
	dialog: ConfirmDialog,
	focus: number,
	cwd: string | undefined,
): readonly Line[] {
	const contentWidth = Math.max(1, width - CONTENT_INSET);
	const row = (content: Line, selected = false): Line => {
		const background = selected ? SELECT_BG : BAND;
		const styledContent = mapLine(
			content,
			(style: Style | undefined) => mergeStyles(style, background) ?? background,
		);
		return concat(
			styled("┃", mergeStyles(ACCENT, background) ?? background),
			styled("  ", background),
			padLine(styledContent, contentWidth, background),
			styled("  ", background),
		);
	};

	const title = truncateLine(styled(dialog.question, TITLE), contentWidth);
	const detail = wrapLine(
		commandDetail(dialogDetail(dialog.detail, dialog.question, cwd), dialog.question),
		{ width: contentWidth, maxLines: 5 },
	);
	const options = DIALOG_OPTIONS.map((option, index) => {
		const focused = index === focus;
		return row(
			concat(
				styled(`${option.key} `, ACCENT),
				styled(`${focused ? "(●)" : "(○)"} `, focused ? TITLE : DIM),
				styled(option.label, focused ? TITLE : DIM),
			),
			focused,
		);
	});

	return [
		row(plain("")),
		row(title),
		...detail.map((line) => row(line)),
		row(plain("")),
		...options,
		row(plain("")),
	];
}

/** 审批详情：能解析成工具参数时显示主参数，不把 JSON 直接摊给使用者。 */
export function dialogDetail(detail: string, question: string, cwd: string | undefined): string {
	try {
		const args: unknown = JSON.parse(detail);
		if (args !== null && typeof args === "object" && !Array.isArray(args)) {
			const match = /^Allow (.+) to run\?$/.exec(question);
			const summary = toolSummary(match?.[1] ?? "", args as Record<string, unknown>, cwd);
			if (summary.length > 0) return summary;
		}
	} catch {
		// 不是 JSON：按原样显示
	}
	return detail;
}

/** bash 命令里的分隔符提亮，帮助一眼看出命令的分段。 */
export function commandDetail(text: string, question: string): Line {
	if (!/bash/i.test(question)) return styled(text, TEXT);
	const parts = text.split(/(\s*(?:;|&&|\|\|)\s*)/);
	return concat(...parts.map((part, index) => (index % 2 === 1 ? styled(part, ACCENT) : styled(part, TEXT))));
}
