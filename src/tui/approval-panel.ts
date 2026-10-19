import type { ApprovalPrompt } from "../permission/approval.ts";
import { BORDER_COLOR, MUTED_COLOR, PANEL_BG, RESET, padEnd } from "./menu-panel.ts";
import { THEME } from "./theme.ts";

/**
 * 工具审批面板。
 *
 * 与菜单面板共用边框和底色。问题一行，参数压成一行缩略；`[y/N]` 明确默认是拒绝。
 * 面板高度固定四行：上边框、问题、参数、下边框。
 */

export const APPROVAL_PANEL_HEIGHT = 4;

export function renderApprovalPanel(
	width: number,
	prompt: ApprovalPrompt,
): readonly string[] {
	const columns = Math.max(1, width);
	const question = `${PANEL_BG}${THEME.warning}${padEnd(`  ${prompt.question}  [y/N]`, columns)}${RESET}`;
	const detail = `${PANEL_BG}${MUTED_COLOR}${padEnd(`  ${compact(prompt.detail)}`, columns)}${RESET}`;

	return [
		`${BORDER_COLOR}${"─".repeat(columns)}${RESET}`,
		question,
		detail,
		`${BORDER_COLOR}${"─".repeat(columns)}${RESET}`,
	];
}

/** 参数是格式化过的 JSON，压成一行才能放进固定高度的面板。 */
function compact(detail: string): string {
	const oneLine = detail.replace(/\s+/g, " ").trim();
	return oneLine.length > 0 ? oneLine : "(no arguments)";
}
