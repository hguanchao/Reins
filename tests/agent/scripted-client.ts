import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../../src/llm/client.ts";
import { EventStream } from "../../src/llm/event-stream.ts";

/**
 * 按脚本应答的模型客户端。
 *
 * 用它驱动整条链路：既不需要网络，也不必为了测一次回合就搭一个假的 HTTP 服务。每次请求都
 * 被记下来，测试据此核对「发出去的到底是什么」。
 */
export class ScriptedClient implements LlmClient {
	readonly api = "scripted";
	readonly requests: LlmRequest[] = [];
	readonly #script: readonly LlmResult[];
	#index = 0;

	constructor(script: readonly LlmResult[]) {
		this.#script = script;
	}

	stream(request: LlmRequest): LlmStream {
		this.requests.push(request);
		const result = this.#script[this.#index] ?? stopResult(request.model);
		this.#index += 1;
		return scriptedStream(result);
	}
}

function scriptedStream(result: LlmResult): LlmStream {
	const stream = EventStream.incremental<LlmEvent, LlmResult>();
	for (const block of result.content) {
		if (block.type === "text" && block.text.length > 0) {
			stream.push({ type: "text_delta", text: block.text });
		}
	}
	stream.close(result);
	return stream;
}

/** 一轮只说话、不调用工具的结果。 */
export function textResult(text: string, model = "test-model"): LlmResult {
	return {
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		stopReason: "stop",
		errorMessage: undefined,
		model,
	};
}

/** 一轮要求调用工具的结果。 */
export function toolCallResult(
	call: { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> },
	model = "test-model",
): LlmResult {
	return {
		content: [
			{ type: "text", text: "我来查一下" },
			{ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments },
		],
		usage: undefined,
		stopReason: "toolUse",
		errorMessage: undefined,
		model,
	};
}

export function stopResult(model = "test-model"): LlmResult {
	return {
		content: [],
		usage: undefined,
		stopReason: "stop",
		errorMessage: undefined,
		model,
	};
}

export function errorResult(message: string, model = "test-model"): LlmResult {
	return {
		content: [],
		usage: undefined,
		stopReason: "error",
		errorMessage: message,
		model,
	};
}
