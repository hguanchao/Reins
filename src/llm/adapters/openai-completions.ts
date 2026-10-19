import type { ModelEntry, ProviderEntry } from "../../config/providers-file.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import { resolveApiKey } from "../api-keys.ts";
import { providerEffortValue } from "../effort.ts";
import { postSse } from "../http.ts";
import type { LlmContentBlock, LlmStopReason, LlmUsage, LlmUserMessage } from "../messages.ts";
import type { RetryPolicy } from "../retry.ts";
import { ContentAccumulator } from "./content-accumulator.ts";
import { createLlmStream, joinUrl } from "./stream-runner.ts";

/**
 * OpenAI 的对话补全协议。
 *
 * 覆盖的不止是 OpenAI 自己：DeepSeek、Qwen、Kimi、本地推理服务等一大批端点都用这套请求与
 * 响应形状，所以它是覆盖面最广的一个适配器。
 *
 * 这套协议没有「内容块」的概念，只有一段文本加一组工具调用。这里给它们编号后交给累积器：
 * 推理内容固定为 0、文本固定为 1，工具调用按协议给的下标排在 2 之后。编号只用于把同一块的
 * 多次增量归到一起，顺带决定了最终内容的先后——推理内容在前，与它出现的次序一致。
 */

const THINKING_INDEX = 0;
const TEXT_INDEX = 1;
const TOOL_CALL_BASE = 2;

interface WireMessage {
	readonly role: string;
	readonly content: string | readonly WireContentPart[] | null;
	readonly tool_calls?: readonly WireToolCall[];
	readonly tool_call_id?: string;
}

type WireContentPart =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image_url"; readonly image_url: { readonly url: string } };

interface WireToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: { readonly name: string; readonly arguments: string };
}

interface StreamDelta {
	readonly content?: string | null;
	/** DeepSeek 与 Qwen 系的推理内容字段 */
	readonly reasoning_content?: string | null;
	/** 部分端点使用的另一种字段名 */
	readonly reasoning?: string | null;
	readonly tool_calls?: readonly {
		readonly index?: number;
		readonly id?: string;
		readonly function?: { readonly name?: string; readonly arguments?: string };
	}[];
}

interface StreamChunk {
	readonly model?: string;
	readonly choices?: readonly { readonly delta?: StreamDelta; readonly finish_reason?: string | null }[];
	readonly usage?: {
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
		readonly total_tokens?: number;
		readonly prompt_tokens_details?: { readonly cached_tokens?: number };
	};
	/** 出错时服务端会回一个 error 对象 */
	readonly error?: { readonly message?: string; readonly type?: string };
}

export class OpenAiCompletionsClient implements LlmClient {
	readonly api = "openai-completions";
	readonly #provider: ProviderEntry;
	readonly #model: ModelEntry;
	readonly #policy: RetryPolicy;

	constructor(provider: ProviderEntry, model: ModelEntry, policy: RetryPolicy) {
		this.#provider = provider;
		this.#model = model;
		this.#policy = policy;
	}

	stream(request: LlmRequest): LlmStream {
		const accumulator = new ContentAccumulator();
		return createLlmStream(
			request,
			(emit) => this.#run(request, emit, accumulator),
			() => {
				accumulator.finishAll();
				return accumulator.blocks();
			},
		);
	}

	async #run(
		request: LlmRequest,
		emit: (event: LlmEvent) => void,
		accumulator: ContentAccumulator,
	): Promise<LlmResult> {
		// 密钥每次请求现取：command 形式的密钥可能是短期有效的，启动时取一次会在长会话里过期
		const apiKey = await resolveApiKey(this.#provider.apiKey, request.signal);
		let finishReason: string | undefined;
		let usage: LlmUsage | undefined;
		let responseModel = this.#model.id;
		/** 是否见到了 [DONE] */
		let done = false;

		await postSse(
			{
				url: joinUrl(this.#model.baseUrl, "/chat/completions"),
				headers: {
					...this.#provider.headers,
					...this.#model.headers,
					...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
				},
				body: this.#buildBody(request),
				signal: request.signal,
				// 结束标记到手就说明这一轮的内容发完了，之后连接怎么断都算正常结束
				complete: () => done || finishReason !== undefined,
			},
			(data) => {
				if (data === "[DONE]") {
					done = true;
					return;
				}

				let chunk: StreamChunk;
				try {
					chunk = JSON.parse(data) as StreamChunk;
				} catch {
					// 单个分片拼不成 JSON 就跳过：后续分片补齐后整轮对话仍然是完整的
					return;
				}
				if (chunk.error !== undefined) {
					throw new Error(`endpoint returned an error: ${chunk.error.message ?? chunk.error.type ?? "no details"}`);
				}
				if (chunk.model !== undefined) responseModel = chunk.model;
				if (chunk.usage !== undefined) usage = toUsage(chunk.usage);

				const choice = chunk.choices?.[0];
				if (choice === undefined) return;
				if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
					finishReason = choice.finish_reason;
				}
				if (choice.delta !== undefined) applyDelta(choice.delta, accumulator, emit);
			},
			this.#policy,
		);

		if (finishReason === undefined && !done) {
			// 两个结束标记一个都没有：响应可能被截断过，当成完成会让残缺的工具调用被执行
			throw new Error("the response has no finish reason; the connection may have been cut off early");
		}
		accumulator.finishAll();

		const content = accumulator.blocks();
		const outcome = outcomeOf(finishReason, content);
		// 空白回答当成功交出去，使用者只会以为模型不想说话；长度截断与内容过滤另有更具体的原因
		if (outcome.stopReason === "stop" && !accumulator.hasOutput()) {
			throw new Error("the endpoint returned an empty response");
		}
		return {
			content,
			usage,
			stopReason: outcome.stopReason,
			errorMessage: outcome.errorMessage,
			model: responseModel,
		};
	}

	#buildBody(request: LlmRequest): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: toWireMessages(request, this.#model.input.includes("image")),
			stream: true,
			// 不带这个字段时端点不会在流里给出用量
			stream_options: { include_usage: true },
		};
		if (request.tools.length > 0) {
			body["tools"] = request.tools.map((tool) => ({
				type: "function",
				function: { name: tool.name, description: tool.description, parameters: tool.parameters },
			}));
		}
		if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
		if (request.effort !== undefined) {
			body["reasoning_effort"] = providerEffortValue(request.effort, this.#model.thinkingLevelMap);
		}
		return body;
	}
}

function applyDelta(
	delta: StreamDelta,
	accumulator: ContentAccumulator,
	emit: (event: LlmEvent) => void,
): void {
	const reasoning = delta.reasoning_content ?? delta.reasoning;
	if (typeof reasoning === "string" && reasoning.length > 0) {
		accumulator.appendThinking(THINKING_INDEX, reasoning);
		emit({ type: "reasoning_delta", text: reasoning });
	}

	if (typeof delta.content === "string" && delta.content.length > 0) {
		accumulator.appendText(TEXT_INDEX, delta.content);
		emit({ type: "text_delta", text: delta.content });
	}

	for (const call of delta.tool_calls ?? []) {
		const index = TOOL_CALL_BASE + (call.index ?? 0);
		if (accumulator.startToolCall(index, call.id ?? "", call.function?.name ?? "")) {
			emit({
				type: "tool_call_start",
				index,
				id: call.id ?? "",
				name: call.function?.name ?? "",
			});
		}
		const args = call.function?.arguments;
		if (typeof args === "string" && args.length > 0) {
			accumulator.appendToolArguments(index, args);
			emit({ type: "tool_call_delta", index, argsJson: args });
		}
	}
}

function toWireMessages(request: LlmRequest, supportsImages: boolean): WireMessage[] {
	const messages: WireMessage[] = [{ role: "system", content: request.system }];

	for (const message of request.messages) {
		switch (message.role) {
			case "user":
				messages.push({ role: "user", content: toWireUserContent(message, supportsImages) });
				break;
			case "assistant":
				messages.push(toWireAssistant(message.content));
				break;
			case "toolResult":
				messages.push({
					role: "tool",
					content: message.content,
					tool_call_id: message.toolCallId,
				});
				break;
		}
	}
	return messages;
}

/**
 * 用户消息的内容。
 *
 * 纯文本仍按字符串发送，兼容只认字符串的端点；带图片时按协议要求换成内容分片数组。
 * 模型不接受图片时用文本说明代替，避免把整张图片发给一个读不了的端点。
 */
function toWireUserContent(
	message: LlmUserMessage,
	supportsImages: boolean,
): string | readonly WireContentPart[] {
	if (typeof message.content === "string") return message.content;

	const parts: WireContentPart[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({ type: "text", text: block.text });
			continue;
		}
		if (supportsImages) {
			parts.push({
				type: "image_url",
				image_url: { url: `data:${block.mimeType};base64,${block.data}` },
			});
		} else {
			parts.push({ type: "text", text: "(image omitted: model does not support images)" });
		}
	}

	if (!parts.some((part) => part.type === "text")) {
		parts.unshift({ type: "text", text: "(see attached image)" });
	}
	// 没有图片时退回字符串，避免无谓地改变普通文本请求的形状
	if (!parts.some((part) => part.type === "image_url")) {
		return parts
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
	}
	return parts;
}

function toWireAssistant(content: readonly LlmContentBlock[]): WireMessage {
	// 这套协议不接受推理块回传，只取文本与工具调用
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
	const calls = content.filter((block) => block.type === "toolCall");

	const message: WireMessage = { role: "assistant", content: text.length > 0 ? text : null };
	if (calls.length === 0) return message;

	return {
		...message,
		tool_calls: calls.map((call) => ({
			id: call.id,
			type: "function" as const,
			function: { name: call.name, arguments: JSON.stringify(call.arguments) },
		})),
	};
}

function toUsage(usage: NonNullable<StreamChunk["usage"]>): LlmUsage {
	const input = usage.prompt_tokens ?? 0;
	const output = usage.completion_tokens ?? 0;
	return {
		input,
		output,
		cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWrite: 0,
		total: usage.total_tokens ?? input + output,
	};
}

/**
 * 终止原因的判定。
 *
 * 内容过滤不算正常收尾：回答被拦下了，接着往下走只会让人以为模型已经把话说完了。只发
 * `[DONE]` 不发结束原因的端点（网关里不罕见）按已产出的内容推断：有工具调用就是在等调用。
 */
function outcomeOf(
	finishReason: string | undefined,
	content: readonly LlmContentBlock[],
): { readonly stopReason: LlmStopReason; readonly errorMessage: string | undefined } {
	if (finishReason === undefined) {
		const toolCall = content.some((block) => block.type === "toolCall");
		return { stopReason: toolCall ? "toolUse" : "stop", errorMessage: undefined };
	}

	switch (finishReason) {
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse", errorMessage: undefined };
		case "length":
			return { stopReason: "length", errorMessage: undefined };
		case "content_filter":
			return {
				stopReason: "error",
				errorMessage: "the response was stopped by the endpoint's content filter",
			};
		default:
			return { stopReason: "stop", errorMessage: undefined };
	}
}
