import type { AgentEvent, AgentEventListener } from "../agent/events.ts";

/**
 * 事件流的 JSONL 出口。
 *
 * 与文本模式共用同一次运行，只是换了消费者：标准输出里每一行是一个完整的事件，标准错误
 * 仍然是给人看的进度。程序据此不需要解析终端输出就能知道发生了什么。
 *
 * 一、tool_end 不带结果全文。工具输出动辄几十 KB，混进事件流会让下游必须先过滤再解析；
 *     需要全文的地方拿工具自己的结构化结果就够了。
 * 二、文本只作为增量事件发出。组装成完整回答是消费者的事，这里再拼一份只会让两边口径
 *     不同步。
 * 三、每行都必须能独立解析。发半个对象出去，下游会把它当成一个坏行丢掉，而真正的错误
 *     反而看不见了。
 */

/** 一种事件写成一行 JSON；末尾的换行是行的分隔，不是内容的一部分。 */
export function serializeEvent(event: AgentEvent): string {
	// tool_end 的全文与结构化结果只给界面用：前者太大，后者不是这个协议的形状
	if (event.type === "tool_end") {
		const { content: _content, details: _details, ...rest } = event;
		return `${JSON.stringify(rest)}\n`;
	}
	return `${JSON.stringify(event)}\n`;
}

export interface JsonStreamDeps {
	/** 写一行；测试替换成收集器 */
	readonly write: (line: string) => void;
}

/** 一次运行的结论：退出码按它决定，与文本模式同一套判断。 */
export interface JsonRunResult {
	readonly failed: boolean;
	readonly finished: boolean;
	readonly error: string | undefined;
}

/** 事件流消费者：每来一个事件写一行，并记下这次运行的结论。 */
export class JsonStream {
	readonly #write: (line: string) => void;
	#state: { failed: boolean; finished: boolean; error: string | undefined } = {
		failed: false,
		finished: false,
		error: undefined,
	};

	constructor(deps: JsonStreamDeps) {
		this.#write = deps.write;
	}

	/**
	 * 交出去的事件监听函数。
	 *
	 * 包一层而不是直接把 handle 递出去：这个函数的签名正好是 AgentEventListener，
	 * 装配处不必为了让类有状态就去关心它的类型。
	 */
	listener(): AgentEventListener {
		return (event) => this.handle(event);
	}

	handle(event: AgentEvent): void {
		if (event.type === "error") {
			this.#state.failed = true;
			this.#state.error = event.message;
		} else if (event.type === "aborted") {
			this.#state.failed = true;
			this.#state.error = "interrupted";
		} else if (event.type === "turn_end") {
			this.#state.finished = true;
		}
		this.#write(serializeEvent(event));
	}

	/**
	 * 这次运行的结论。
	 *
	 * 与文本模式同一套判断：出错或中止算失败，没到达 turn_end 也算没跑完。两者都意味着
	 * 下游不能把已经收到的内容当成完整结果。
	 */
	result(): JsonRunResult {
		return { ...this.#state };
	}
}
