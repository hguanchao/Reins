import {
	planHeaderInView,
	subagentFailureRowInView,
	subagentGroupHeaderInView,
	thinkingHeaderInView,
	todoHeaderInView,
	toolGroupHeaderInView,
	toolHeaderInView,
} from "#src/tui/transcript.ts";
import { invalidateTranscriptPrefix, markTranscriptDirty } from "#src/tui/runtime/transcript-state.ts";
import { openPlanReview } from "#src/tui/runtime/pages.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

/**
 * 双击对话流里的可展开行。
 *
 * 审批卡显示时也复用这一套：审批是模态的，但上方的对话流仍然可以查看，不能被一起冻结。
 * 返回 true 表示这一下已被某个可展开行消费。
 */
export function togglingTranscriptAt(
	host: TuiHost,
	row: number,
	column: number,
	mainHeight: number,
	width: number,
): boolean {
	const state = host.state;
	// 展开状态是就地修改的：前缀缓存只比较回合引用，不会发现这种变化，必须显式失效
	const refresh = (): void => {
		invalidateTranscriptPrefix(state);
		markTranscriptDirty(state);
	};
	if (row > mainHeight || column >= width - 1) return false;
	const view = host.currentTranscript(width);

	const plan = planHeaderInView(view, mainHeight, state.scrollTop, row);
	if (plan !== undefined) {
		// 审批卡还在等回答时不开第二个模态页，先让使用者处理当前审批
		if (state.approvalPrompt === undefined) {
			state.lastClick = undefined;
			openPlanReview(host, plan);
			host.render();
		}
		return true;
	}

	const block = thinkingHeaderInView(view, mainHeight, state.scrollTop, row);
	if (block !== undefined) {
		block.expanded = !block.expanded;
		refresh();
		state.lastClick = undefined;
		// 保持标题在点击时的屏幕位置：跟随到底部会让长内容直接跳到末尾
		state.follow = false;
		host.render();
		return true;
	}

	const group = toolGroupHeaderInView(view, mainHeight, state.scrollTop, row);
	if (group !== undefined) {
		group.expanded = !group.expanded;
		refresh();
		state.lastClick = undefined;
		state.follow = false;
		host.render();
		return true;
	}

	const tool = toolHeaderInView(view, mainHeight, state.scrollTop, row);
	if (tool !== undefined) {
		// 一次双击把这一行藏着的东西打开。有 fullDetail 时展开的就是它本身
		// （文件类工具的结果、或被截短的命令），不再另铺一遍原始结果
		const open = tool.detailExpanded === true || tool.resultExpanded === true;
		tool.detailExpanded = !open;
		// 两个展开标志互斥：有完整详情时只展开详情，否则结果色带会被追加第二遍
		tool.resultExpanded = !open && tool.fullDetail === undefined && tool.result !== undefined;
		refresh();
		state.lastClick = undefined;
		state.follow = false;
		host.render();
		return true;
	}

	const todo = todoHeaderInView(view, mainHeight, state.scrollTop, row);
	if (todo !== undefined) {
		todo.collapsed = todo.collapsed !== true;
		refresh();
		state.lastClick = undefined;
		state.follow = false;
		host.render();
		return true;
	}

	const subagents = subagentGroupHeaderInView(view, mainHeight, state.scrollTop, row);
	if (subagents !== undefined) {
		subagents.expanded = subagents.expanded !== true;
		refresh();
		state.lastClick = undefined;
		state.follow = false;
		host.render();
		return true;
	}

	// 失败的子代理清单行:双击展开/收起失败原因
	const failedRow = subagentFailureRowInView(view, mainHeight, state.scrollTop, row);
	if (failedRow !== undefined) {
		const member = failedRow.group.members.find((item) => item.callId === failedRow.callId);
		if (member !== undefined) {
			member.expanded = member.expanded !== true;
			refresh();
			state.lastClick = undefined;
			state.follow = false;
			host.render();
			return true;
		}
	}
	return false;
}
