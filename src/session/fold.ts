import type { LlmMessage } from "../llm/messages.ts";
import type { SessionEntry, SessionState, SessionToolDeclaration } from "./port.ts";

/**
 * 会话条目的折叠。
 *
 * 会话的写入方边追加边维护同一份状态（见 SessionFolder），这里另给一条只看条目的路径：
 * 把文件从头重放一遍，必须得到与当时实际发出去的一模一样的请求。这条约定是会话格式的核心
 * ——下一次请求要用的东西全部来自记录，没有任何藏在内存里的补充。
 */

interface MutableState {
	sections: Record<string, string>;
	tools: SessionToolDeclaration[];
	messages: LlmMessage[];
	model: { provider: string; model: string } | undefined;
	effort: string | undefined;
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
			messages: [...this.#state.messages],
			model: this.#state.model,
			effort: this.#state.effort,
		};
	}
}

/** 从零折叠出状态：读文件与导出走这条路。 */
export function foldEntries(entries: readonly SessionEntry[]): SessionState {
	const folder = new SessionFolder();
	for (const entry of entries) folder.add(entry);
	return folder.state();
}

function applyEntry(state: MutableState, entry: SessionEntry): void {
	switch (entry.type) {
		case "message":
			state.messages.push(entry.message);
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
	}
}
