import { findCommand } from "#src/tui/commands.ts";
import { TURN_SAFE_COMMANDS } from "#src/tui/commands.ts";
import { commandArgs } from "#src/tui/commands.ts";
import { IMAGE_STILL_READING, STATUS, queuedOverflow, unknownCommand, waitForTurn } from "#src/tui/copy.ts";
import { expandPastes } from "#src/tui/paste.ts";
import { attachmentLimit, clearAttachments, imagesOf } from "#src/tui/input/attachments.ts";
import { QUEUE_MAX_VISIBLE } from "#src/tui/view/footer.ts";
import { markTranscriptDirty } from "#src/tui/runtime/transcript-state.ts";
import { drainQueue } from "#src/tui/runtime/run.ts";
import { executeCommand } from "#src/tui/runtime/commands.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

/**
 * 回车提交。
 *
 * 命令先于受限检查执行：/model 正是用来修复配置对不上的入口。一轮进行中不丢输入，
 * 排进队列等本轮收尾后自动发送。
 */
export function submit(host: TuiHost): boolean {
	const state = host.state;
	if (state.restoringCheckpoint) {
		// 工作区正在恢复，此时开新回合会让模型看到一半旧、一半新的文件
		host.setStatus(STATUS.restoringCheckpoint, "notice");
		host.scheduleStatusClear();
		host.render();
		return false;
	}
	if (state.imageLoading) {
		// 标记还没落进输入框，此时发送会得到一轮文字与图片对不上的消息
		host.setStatus(IMAGE_STILL_READING, "notice");
		host.scheduleStatusClear();
		host.render();
		return false;
	}
	if (state.reviewing) {
		// 审查子代理正往会话里记用量；此时开新回合或换会话会让两边同时写同一份文件
		host.setStatus(STATUS.reviewRunningCancel, "notice");
		host.scheduleStatusClear();
		host.render();
		return false;
	}
	if (state.input.length === 0) {
		// 输入框空着而队列里还有东西：回车把队首发出去，中止之后靠它恢复队列
		if (state.activeTurn !== undefined || state.queued.length === 0) return false;
		drainQueue(host);
		return true;
	}

	const message = state.input.trim();
	if (message.length === 0) return false;
	// 折叠的粘贴在发送这一刻才换回原文：输入框与历史里留标记，模型拿到全文
	const expanded = expandPastes(state.pastes, message);
	// 补全面板已经明确高亮了一项，回车就执行它：只输入 "/" 时使用者看到的也是
	// 「/model 被选中」，此时回车没有反应会让人以为按键失灵。过滤层已经保证有命令名
	// 前缀命中时不会混入描述命中，所以这里不需要再按输入前缀二次校验。
	const selected = state.commandMenu?.items[state.commandMenu.cursor];
	// 只有一个斜杠、又没有选中项：还不算命令，也不该当成提问发给模型
	if (message === "/" && selected === undefined) return false;
	const command = selected ?? findCommand(message, host.commands());
	if (message.startsWith("/") && command === undefined) {
		// 斜杠开头没有对应命令时不要把它当普通提问发给模型
		state.commandMenu = undefined;
		host.resetStatusMeta();
		host.setStatus(unknownCommand(message.split(/\s/, 1)[0] ?? ""), "warning");
		host.render();
		return false;
	}
	if (message.startsWith("/") && command !== undefined) {
		// 一轮进行中只放行不碰对话的命令；其余要等这一轮结束，但得说清为什么没执行。
		// 补全面板此刻占着状态行的位置，先收起它，提示才看得见
		if (state.activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(command.name)) {
			state.commandMenu = undefined;
			state.commandMenuDismissed = true;
			host.setStatus(waitForTurn(`/${command.name}`), "notice");
			host.render();
			return false;
		}
		// 命令先于受限检查执行：/model 正是用来修复配置对不上的入口
		host.rememberInput(message);
		executeCommand(host, command, selected === undefined ? commandArgs(message, command.name) : "");
		return true;
	}

	host.rememberInput(message);
	const images = imagesOf(state);
	const attachmentError = attachmentLimit(images);
	if (attachmentError !== undefined) {
		host.setStatus(attachmentError, "warning");
		host.scheduleStatusClear();
		host.render();
		return false;
	}
	// 一轮进行中不再丢输入：排进队列，本轮收尾后自动发送
	if (state.activeTurn !== undefined) {
		clearAttachments(host);
		state.commandMenu = undefined;
		host.setInput("");
		state.queued.push({ text: expanded, images });
		// 队列越多，页脚越高，对话流就越矮。超过能显示的行数之后照收不误，但要当场说一句：
		// 静默接受会让人以为消息丢了，而它其实排在后面。
		if (state.queued.length > QUEUE_MAX_VISIBLE) {
			host.setStatus(queuedOverflow(state.queued.length, QUEUE_MAX_VISIBLE), "notice");
			host.scheduleStatusClear();
		}
		host.render();
		return true;
	}

	if (!state.ready) {
		// 配置没读成功时不进入对话：保留输入与图片标记，只把原因放到运行时状态行
		state.commandMenu = undefined;
		host.resetStatusMeta();
		host.setStatus(STATUS.configurationInvalid, "notice");
		host.render();
		return false;
	}

	clearAttachments(host);
	host.setInput("");
	host.launch(expanded, images);
	return true;
}

export { markTranscriptDirty };
