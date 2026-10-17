import type { KeyEvent } from "../../tui/input/keys.ts";

/**
 * 征求同意。
 *
 * 这正是审批链里那个「问使用者」的落点：界面把提问摆成一张卡片，数字直选，回车按聚焦的那项
 * 算，Esc 拒绝。除了明确的「允许」，其余一律按拒绝处理——不确定就按最保守的一侧。
 *
 * 这里只管「按下的键算不算同意」；卡片怎么摆、命令在哪儿显示，由界面决定。
 */

export interface ConfirmDialog {
	readonly question: string;
	readonly detail: string;
	readonly resolve: (allowed: boolean) => void;
}

/** 选项：编号、文案、以及选中它算不算同意。 */
export interface DialogOption {
	readonly key: string;
	readonly label: string;
	readonly allowed: boolean;
}

/**
 * 卡片的两个选项。
 *
 * 只有「允许／拒绝」两种结果：审批策略里没有「以后都允许」这一档，摆出来就是在骗人。
 */
export const DIALOG_OPTIONS: readonly DialogOption[] = [
	{ key: "1", label: "Allow", allowed: true },
	{ key: "2", label: "Deny", allowed: false },
];

/**
 * 把按键翻译成结论；返回 undefined 表示这个键不作数，卡片继续等。
 *
 * 数字是直选：按下去就定了，不必再回车。回车按聚焦的那一项算（第一项，也就是允许），
 * `y`/`n` 这类习惯按法一并认。
 */
export function dialogDecision(event: KeyEvent): boolean | undefined {
	if (event.type === "text") {
		const text = event.text.trim().toLowerCase();
		if (text === "y" || text === "yes") return true;
		if (text === "n" || text === "no") return false;
		const option = DIALOG_OPTIONS.find((item) => item.key === text);
		return option?.allowed;
	}
	if (event.type !== "key") return undefined;

	switch (event.name) {
		case "enter":
			return DIALOG_OPTIONS[0]?.allowed;
		case "escape":
			return false;
		default:
			return undefined;
	}
}
