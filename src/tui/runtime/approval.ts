import type { ApprovalAnswer } from "../../permission/policy.ts";
import { terminalHeight } from "../terminal.ts";
import type { TuiOptions } from "../options.ts";
import { footerHeight } from "./geometry.ts";
import { approvalActions } from "./state.ts";
import type { TuiHost, TuiState } from "./types.ts";

/**
 * 审批卡与面板几何。
 *
 * 请求来自工具线程，异步出现：刷新帧顺带把它同步到界面，出现变化时才重置默认选项。
 */

/** 同步当前待审批请求；返回界面是否需要重绘。 */
export function syncApprovalPrompt(host: TuiHost): boolean {
	const next = host.options.approval?.pending();
	const state = host.state;
	const changed =
		next === undefined
			? state.approvalPrompt !== undefined
			: state.approvalPrompt === undefined ||
				state.approvalPrompt.tool !== next.tool ||
				state.approvalPrompt.risk !== next.risk ||
				state.approvalPrompt.detail !== next.detail ||
				state.approvalPrompt.saveShort !== next.saveShort;
	if (next !== undefined && changed) {
		state.approvalSelection = "once";
	}
	state.approvalPrompt = next;
	return changed;
}

/** 把结论交回权限门；下一个排队请求若存在会立即顶上来，并重置为默认允许一次。 */
export function resolveApproval(host: TuiHost, answer: ApprovalAnswer): void {
	host.options.approval?.resolve(answer);
	host.state.approvalPrompt = undefined;
	syncApprovalPrompt(host);
	host.render();
}

/** 左右键在当前可用的动作之间移动高亮。 */
export function moveApprovalSelection(host: TuiHost, delta: number): void {
	const prompt = host.state.approvalPrompt;
	if (prompt === undefined) return;
	const actions = approvalActions(prompt.saveShort) as readonly ApprovalAnswer[];
	let index = actions.indexOf(host.state.approvalSelection);
	if (index < 0) index = 0;
	host.state.approvalSelection =
		actions[Math.min(actions.length - 1, Math.max(0, index + delta))] ?? "once";
	host.render();
}

/** 审批面板顶行：页脚高度就是面板高度，面板从底部往上铺。 */
export function approvalPanelTop(state: TuiState, options: TuiOptions): number {
	return Math.max(0, terminalHeight(state.stdout) - footerHeight(state, options));
}

/** 模态选择面板的上边框行号；面板画在页脚区的第一行。 */
export function menuPanelTop(state: TuiState, options: TuiOptions): number {
	return Math.max(1, terminalHeight(state.stdout) - footerHeight(state, options) + 1);
}
