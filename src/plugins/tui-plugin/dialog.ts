import type { KeyEvent } from "../../tui/input/keys.ts";

/**
 * 征求同意。
 *
 * 这正是审批链里那个「问使用者」的落点：界面起来之后，需要确认的调用会走到这里，底部那块
 * 换成一句提问，键盘暂时归它。只有明确的肯定才算同意，其余（拒绝、Esc、被中断、看不懂的键）
 * 都不改变结论——不确定就按最保守的一侧处理。
 *
 * 这里只管「按下的键算不算同意」；提问怎么摆、命令在哪儿显示，由界面决定。
 */

export interface ConfirmDialog {
	readonly question: string;
	readonly detail: string;
	readonly resolve: (allowed: boolean) => void;
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
