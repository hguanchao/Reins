import { plain, styled, type Line } from "../../tui/index.ts";
import type { KeyEvent } from "../../tui/input/keys.ts";
import { renderBox } from "../../tui/widgets/box.ts";

/**
 * 征求同意。
 *
 * 这正是审批链里那个「问使用者」的落点：界面起来之后，需要确认的调用会走到这里，界面上多出
 * 一个方块，键盘暂时归它。只有明确的肯定才算同意，其余（拒绝、Esc、被中断、看不懂的键）
 * 都不改变结论——不确定就按最保守的一侧处理。
 */

/** 参数内容最多显示几行。对话框不该需要滚动。 */
const DETAIL_LINES = 6;

export interface ConfirmDialog {
	readonly question: string;
	readonly detail: string;
	readonly resolve: (allowed: boolean) => void;
}

export function dialogLines(dialog: ConfirmDialog, width: number): readonly Line[] {
	return renderBox({
		width: Math.min(width, 100),
		title: dialog.question,
		border: { color: "yellow" },
		lines: [
			...detailLines(dialog.detail),
			[],
			styled("[y] 允许　[n] 拒绝", { bold: true }),
		],
	});
}

/** 把按键翻译成结论；返回 undefined 表示这个键不作数，对话框继续等。 */
export function dialogDecision(event: KeyEvent): boolean | undefined {
	if (event.type === "text") {
		const text = event.text.trim().toLowerCase();
		if (text === "y" || text === "yes") return true;
		if (text === "n" || text === "no") return false;
		return undefined;
	}
	if (event.type !== "key") return undefined;

	switch (event.name) {
		case "enter":
			return true;
		case "escape":
			return false;
		default:
			return undefined;
	}
}

function detailLines(detail: string): readonly Line[] {
	const lines = detail.split("\n");
	const kept = lines.slice(0, DETAIL_LINES).map((line) => plain(line));
	if (lines.length <= DETAIL_LINES) return kept;
	return [...kept, styled("…", { dim: true })];
}
