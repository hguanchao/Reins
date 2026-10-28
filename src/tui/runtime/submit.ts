import { findCommand } from "../commands.ts";
import { TURN_SAFE_COMMANDS } from "../commands.ts";
import { commandArgs } from "../commands.ts";
import { CONFIGURATION_REQUIRED } from "../render/status.ts";
import { attachmentLimit, clearAttachments, imagesOf } from "../input/attachments.ts";
import { QUEUE_MAX_VISIBLE } from "../view/footer.ts";
import { markTranscriptDirty } from "./transcript-state.ts";
import { drainQueue } from "./run.ts";
import { executeCommand } from "./commands.ts";
import type { TuiHost } from "./types.ts";

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
		host.setStatus("Restoring checkpoint...", "notice");
		host.scheduleStatusClear();
		host.render();
		return false;
	}
	if (state.imageLoading) {
		// 标记还没落进输入框，此时发送会得到一轮文字与图片对不上的消息
		host.setStatus("Still reading an image; try again in a moment", "notice");
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
	const selected = state.commandMenu?.items[state.commandMenu.cursor];
	// 只有一个斜杠、又没有选中项：还不算命令，也不该当成提问发给模型
	if (message === "/" && selected === undefined) return false;
	const command = selected ?? findCommand(message, host.commands());
	if (message.startsWith("/") && command === undefined) {
		// 斜杠开头没有对应命令时不要把它当普通提问发给模型
		state.commandMenu = undefined;
		host.resetStatusMeta();
		host.setStatus(`Unknown command: ${message.split(/\s/, 1)[0]}`, "warning");
		host.render();
		return false;
	}
	if (message.startsWith("/") && command !== undefined) {
		// 一轮进行中只放行不碰对话的命令；其余要等这一轮结束，但得说清为什么没执行。
		// 补全面板此刻占着状态行的位置，先收起它，提示才看得见
		if (state.activeTurn !== undefined && !TURN_SAFE_COMMANDS.has(command.name)) {
			state.commandMenu = undefined;
			state.commandMenuDismissed = true;
			host.setStatus(`/${command.name} is unavailable while a turn is running`, "notice");
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
		state.queued.push({ text: message, images });
		// 队列越多，页脚越高，对话流就越矮。超过能显示的行数之后照收不误，但要当场说一句：
		// 静默接受会让人以为消息丢了，而它其实排在后面。
		if (state.queued.length > QUEUE_MAX_VISIBLE) {
			host.setStatus(
				`Queued (${state.queued.length}); only the first ${QUEUE_MAX_VISIBLE} are shown`,
				"notice",
			);
			host.scheduleStatusClear();
		}
		host.render();
		return true;
	}

	if (!state.ready) {
		// 配置没读成功时不进入对话：保留输入与图片标记，只把原因放到运行时状态行
		state.commandMenu = undefined;
		host.resetStatusMeta();
		host.setStatus(CONFIGURATION_REQUIRED, "notice");
		host.render();
		return false;
	}

	clearAttachments(host);
	host.setInput("");
	host.launch(message, images);
	return true;
}

export { markTranscriptDirty };
