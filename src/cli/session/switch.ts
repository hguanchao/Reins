import type { Session } from "../../session/session.ts";
import type { SessionStore } from "../../session/store.ts";
import { buildTranscriptHistory } from "../../tui/transcript/history.ts";
import type { TranscriptTodo } from "../../tui/view/todo-card.ts";
import type { TranscriptPlan, TranscriptTurn } from "../../tui/transcript.ts";
import { resumeSession } from "./target.ts";

interface SwitchedSession {
	readonly session: Session;
	readonly history: readonly TranscriptTurn[];
	/** 目标会话最后一张任务表；没有时面板保持收起 */
	readonly todo?: TranscriptTodo;
	/** 目标会话最近一份计划；供 /view-plan 恢复 */
	readonly plan?: TranscriptPlan;
}

/**
 * 打开目标会话并读出它的对话流。
 *
 * 目标文件缺失或损坏时在打开阶段就失败，当前会话完全不受影响；关闭旧会话由调用方拿到
 * 新会话之后再做，保证写入器交接只有一次。
 */
export function openSessionForSwitch(
	workRoot: string,
	id: string,
	store: SessionStore,
): SwitchedSession {
	const session = resumeSession(workRoot, id, store);
	try {
		const history = buildTranscriptHistory(session.state().messages, workRoot);
		return {
			session,
			history: history.turns,
			...(history.todo === undefined ? {} : { todo: history.todo }),
			...(history.plan === undefined ? {} : { plan: history.plan }),
		};
	} catch (error) {
		// 读不出历史就不再保留这个目标会话的写入通道；原始错误更重要，关闭失败不再覆盖它
		void session.close().catch(() => {});
		throw error;
	}
}
