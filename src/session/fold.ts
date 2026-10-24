import type { LlmMessage, LlmUserMessage } from "../llm/messages.ts";
import type { SessionEntry, SessionState, SessionToolDeclaration } from "./port.ts";

/**
 * 会话条目的折叠。
 *
 * 会话的写入方边追加边维护同一份状态（见 SessionFolder），这里另给一条只看条目的路径：
 * 把文件从头重放一遍，必须得到与当时实际发出去的一模一样的请求。这条约定是会话格式的核心
 * ——下一次请求要用的东西全部来自记录，没有任何藏在内存里的补充。
 *
 * 压缩条目在这一层生效：被摘要取代的消息退出上下文，摘要本身排在上下文最前面。条目一条都
 * 不删，所以用量统计与导出仍看得到完整历史。
 */

interface RecordedMessage {
	readonly id: string;
	readonly message: LlmMessage;
}

interface MutableState {
	sections: Record<string, string>;
	tools: SessionToolDeclaration[];
	messages: RecordedMessage[];
	model: { provider: string; model: string } | undefined;
	effort: string | undefined;
}

/**
 * 摘要进入上下文时的外壳。
 *
 * 必须让模型一眼看出这是先前对话的替代品，否则它会以为有人刚说了这么一段话，从而把摘要里
 * 的第三手描述当成新的指令。
 */
export function summaryMessage(summary: string): LlmUserMessage {
	return { role: "user", content: `(Summary of the earlier conversation, kept so the work can continue)\n\n${summary}` };
}

/** 增量折叠。写入方每追加一条就加一条，避免每写一条都重放整份历史。 */
export class SessionFolder {
	readonly #state: MutableState = {
		sections: {},
		tools: [],
		messages: [],
		model: undefined,
		effort: undefined,
	};

	add(entry: SessionEntry): void {
		applyEntry(this.#state, entry);
	}

	/** 数组做一次浅拷贝，避免调用方持有内部数组。 */
	state(): SessionState {
		return {
			sections: { ...this.#state.sections },
			tools: [...this.#state.tools],
			messages: this.#state.messages.map((record) => record.message),
			messageIds: this.#state.messages.map((record) => record.id),
			model: this.#state.model,
			effort: this.#state.effort,
		};
	}
}

/** 从零折叠出状态：测试与一次性导出走这条路；持续读文件走 SessionFolder 的增量接口。 */
export function foldEntries(entries: readonly SessionEntry[]): SessionState {
	const folder = new SessionFolder();
	for (const entry of entries) folder.add(entry);
	return folder.state();
}

function applyEntry(state: MutableState, entry: SessionEntry): void {
	switch (entry.type) {
		case "message":
			state.messages.push({ id: entry.id, message: entry.message });
			return;
		case "system":
			for (const [name, body] of Object.entries(entry.sections)) {
				if (body === null) delete state.sections[name];
				else state.sections[name] = body;
			}
			for (const name of entry.toolsRemoved ?? []) {
				state.tools = state.tools.filter((tool) => tool.name !== name);
			}
			for (const tool of entry.toolsAdded ?? []) {
				state.tools = [...state.tools.filter((item) => item.name !== tool.name), tool];
			}
			return;
		case "model_change":
			state.model = { provider: entry.provider, model: entry.model };
			return;
		case "effort_change":
			state.effort = entry.effort;
			return;
		case "compaction": {
			// 摘要排在最前：它替代的消息都在压缩点之前，其中若还有保留下来的（压缩只覆盖前面
			// 一段），那些消息也必须排在摘要之后，否则模型会先读到后半段再读到提要
			const covered = new Set(entry.covered);
			state.messages = [
				{ id: entry.id, message: summaryMessage(entry.summary) },
				...state.messages.filter((record) => !covered.has(record.id)),
			];
			return;
		}
		case "usage":
			// 用量只进统计，不进上下文
			return;
	}
}
