import type { ModelEntry, ProviderEntry } from "../../config/providers-file.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import { resolveApiKey } from "../api-keys.ts";
import { providerEffortValue } from "../effort.ts";
import { postSse } from "../http.ts";
import type { LlmContentBlock, LlmMessage, LlmStopReason, LlmUsage, LlmUserMessage } from "../messages.ts";
import type { RetryPolicy } from "../retry.ts";
import { ContentAccumulator } from "./content-accumulator.ts";
import { createLlmStream, joinUrl } from "./stream-runner.ts";

/**
 * OpenAI 的 Responses 协议。
 *
 * 与对话补全协议的结构性差别：请求体不是一串 messages，而是按输出项排列的 item 列表；
 * 助手的文本、思考与工具调用各自是独立 item，工具结果用 function_call_output 回传。
 * 流里的块生命周期也由 output_item.added / output_item.done 划定，而不是由分片里的下标
 * 自行推断。
 *
 * 请求固定 store:false：会话状态由本程序自己保存，思考项连同加密内容随消息一起回传，
 * 这样多轮工具调用不依赖服务端保存会话。
 */

/** OpenAI 要求输出上限至少 16，低于这个值的请求会被直接拒绝。 */
const MIN_OUTPUT_TOKENS = 16;

interface WireItem {
	readonly type?: string;
	readonly id?: string;
	readonly call_id?: string;
	readonly name?: string;
	readonly arguments?: string;
	readonly encrypted_content?: string;
	readonly summary?: readonly WireTextPart[];
	readonly content?: readonly WireTextPart[];
}

interface WireTextPart {
	readonly type?: string;
	readonly text?: string;
	readonly refusal?: string;
}

interface WireUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly total_tokens?: number;
	readonly input_tokens_details?: {
		readonly cached_tokens?: number;
		readonly cache_write_tokens?: number;
	};
}

interface WireResponse {
	readonly id?: string;
	readonly model?: string;
	readonly status?: string;
	readonly error?: { readonly code?: string; readonly message?: string };
	readonly incomplete_details?: { readonly reason?: string } | null;
	readonly usage?: WireUsage;
}

interface StreamEvent {
	readonly type?: string;
	readonly output_index?: number;
	readonly item?: WireItem;
	readonly delta?: string;
	readonly arguments?: string;
	readonly response?: WireResponse;
	readonly message?: string;
	readonly code?: string;
}

interface Terminal {
	readonly status: string;
	readonly reason: string | undefined;
}

export class OpenAiResponsesClient implements LlmClient {
	readonly api = "openai-responses";
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
		/** 已经出现但还没收到 output_item.done 的工具调用 */
		const pendingTools = new Set<number>();
		/** 流里先到的完整参数；output_item.done 可能省略 arguments */
		const finalArguments = new Map<number, string>();
		let terminal: Terminal | undefined;
		let usage: LlmUsage | undefined;
		let responseModel = this.#model.id;

		await postSse(
			{
				url: joinUrl(this.#model.baseUrl, "/responses"),
				headers: {
					...this.#provider.headers,
					...this.#model.headers,
					...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
				},
				body: this.#buildBody(request),
				signal: request.signal,
				// 终止事件到手就说明这一轮发完了，之后连接怎么断都算正常结束
				complete: () => terminal !== undefined,
			},
			(data) => {
				let event: StreamEvent;
				try {
					event = JSON.parse(data) as StreamEvent;
				} catch {
					// 单个分片拼不成 JSON 就跳过：后续事件仍然能把这一轮补完整
					return;
				}

				const index = event.output_index;
				switch (event.type) {
					case "response.created":
						if (event.response?.model !== undefined) responseModel = event.response.model;
						return;
					case "response.output_item.added":
						if (index !== undefined && event.item !== undefined) {
							startItem(index, event.item, accumulator, pendingTools, emit);
						}
						return;
					case "response.reasoning_summary_text.delta":
					case "response.reasoning_text.delta":
						if (index !== undefined && typeof event.delta === "string") {
							accumulator.appendThinking(index, event.delta);
							emit({ type: "reasoning_delta", text: event.delta });
						}
						return;
					case "response.reasoning_summary_part.done":
						if (index !== undefined) {
							accumulator.appendThinking(index, "\n\n");
							emit({ type: "reasoning_delta", text: "\n\n" });
						}
						return;
					case "response.output_text.delta":
					case "response.refusal.delta":
						if (index !== undefined && typeof event.delta === "string") {
							accumulator.appendText(index, event.delta);
							emit({ type: "text_delta", text: event.delta });
						}
						return;
					case "response.function_call_arguments.delta":
						if (index !== undefined && typeof event.delta === "string") {
							accumulator.appendToolArguments(index, event.delta);
							emit({ type: "tool_call_delta", index, argsJson: event.delta });
						}
						return;
					case "response.function_call_arguments.done":
						if (index !== undefined && typeof event.arguments === "string") {
							finalArguments.set(index, event.arguments);
						}
						return;
					case "response.output_item.done":
						if (index !== undefined && event.item !== undefined) {
							finishItem(index, event.item, finalArguments, accumulator, pendingTools, emit);
						}
						return;
					case "response.completed":
					case "response.incomplete": {
						if (event.response?.model !== undefined) responseModel = event.response.model;
						if (event.response?.usage !== undefined) usage = toUsage(event.response.usage);
						terminal = {
							status: event.type === "response.incomplete" ? "incomplete" : (event.response?.status ?? "completed"),
							reason: event.response?.incomplete_details?.reason,
						};
						return;
					}
					case "response.failed": {
						const error = event.response?.error;
						const reason = event.response?.incomplete_details?.reason;
						throw new Error(
							error?.message ??
								(reason === undefined ? "response failed without details" : `response incomplete: ${reason}`),
						);
					}
					case "error":
						throw new Error(event.message ?? event.code ?? "endpoint returned an error");
					default:
						return;
				}
			},
			this.#policy,
		);

		if (terminal === undefined) {
			// 没有终止事件的流可能被截断过；当成完成会让残缺的工具调用被执行
			throw new Error("the response has no terminal event; the connection may have been cut off early");
		}
		if (pendingTools.size > 0) {
			// 参数可能只到一半；把它当完整调用执行，工具会收到一个错误的参数对象
			throw new Error("the response completed with an unfinished tool call");
		}
		accumulator.finishAll();

		const content = accumulator.blocks();
		const mapped = stopReasonOf(terminal.status, terminal.reason, content);
		// 空白回答当成功交出去，使用者只会以为模型不想说话；长度截断与内容过滤另有更具体的原因
		if (mapped.stopReason === "stop" && !accumulator.hasOutput()) {
			throw new Error("the endpoint returned an empty response");
		}
		return {
			content,
			usage,
			stopReason: mapped.stopReason,
			errorMessage: mapped.errorMessage,
			model: responseModel,
		};
	}

	#buildBody(request: LlmRequest): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: request.model,
			input: toInput(request.messages, this.#model.input.includes("image")),
			stream: true,
			// 会话由本程序保存；关闭服务端存储，避免两套历史各说各话
			store: false,
		};

		if (request.system.length > 0) body["instructions"] = request.system;
		if (request.tools.length > 0) {
			body["tools"] = request.tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}));
		}
		if (request.maxTokens !== undefined) {
			body["max_output_tokens"] = Math.max(MIN_OUTPUT_TOKENS, request.maxTokens);
		}

		if (this.#model.reasoning) {
			if (request.effort !== undefined) {
				body["reasoning"] = {
					effort: providerEffortValue(request.effort, this.#model.thinkingLevelMap),
					summary: "auto",
				};
				// 无状态请求必须在下一轮把思考项的加密内容原样带回
				body["include"] = ["reasoning.encrypted_content"];
			} else {
				const off = this.#model.thinkingLevelMap.off;
				// 显式声明 off 不支持时不要发任何思考参数
				if (off !== null) body["reasoning"] = { effort: off ?? "none" };
			}
		}

		return body;
	}
}

/** 输出项出现时只建立工具调用；文本与思考等第一个增量到来再建块。 */
function startItem(
	index: number,
	item: WireItem,
	accumulator: ContentAccumulator,
	pendingTools: Set<number>,
	emit: (event: LlmEvent) => void,
): void {
	if (item.type !== "function_call") return;
	beginToolCall(index, item, accumulator, pendingTools, emit);
}

/** 输出项结束时补上协议只在末尾给出的完整文本、签名与工具参数。 */
function finishItem(
	index: number,
	item: WireItem,
	finalArguments: Map<number, string>,
	accumulator: ContentAccumulator,
	pendingTools: Set<number>,
	emit: (event: LlmEvent) => void,
): void {
	switch (item.type) {
		case "reasoning": {
			const text = joinText(item.summary, "\n\n") || joinText(item.content, "\n\n");
			if (text.length > 0) accumulator.setThinkingText(index, text);
			// 整项原样保存：下一轮要连同 id 与加密内容一起回传
			accumulator.setThinkingSignature(index, JSON.stringify(item));
			return;
		}
		case "message": {
			const text = joinText(item.content, "");
			if (text.length > 0) accumulator.setText(index, text);
			return;
		}
		case "function_call": {
			beginToolCall(index, item, accumulator, pendingTools, emit);
			const final = item.arguments !== undefined && item.arguments.length > 0 ? item.arguments : finalArguments.get(index);
			accumulator.finish(index, final);
			pendingTools.delete(index);
			emit({ type: "tool_call_end", index });
			return;
		}
		default:
			return;
	}
}

function beginToolCall(
	index: number,
	item: WireItem,
	accumulator: ContentAccumulator,
	pendingTools: Set<number>,
	emit: (event: LlmEvent) => void,
): void {
	const id = toolCallId(item);
	if (!accumulator.startToolCall(index, id, item.name ?? "")) return;
	pendingTools.add(index);
	emit({ type: "tool_call_start", index, id, name: item.name ?? "" });
}

/**
 * 工具调用的标识。
 *
 * call_id 用来把调用与结果配对，item id 用来让端点把调用与同一轮的思考项关联起来。
 * 两个都保留：只带 call_id 时，部分端点会拒绝回传带思考的工具调用。
 */
function toolCallId(item: WireItem): string {
	const callId = item.call_id === undefined || item.call_id.length === 0 ? undefined : item.call_id;
	const itemId = item.id === undefined || item.id.length === 0 ? undefined : item.id;
	if (callId === undefined) return itemId ?? "";
	if (itemId === undefined) return callId;
	return `${callId}|${itemId}`;
}

function splitToolCallId(id: string): { readonly callId: string; readonly itemId: string | undefined } {
	const separator = id.indexOf("|");
	if (separator === -1) return { callId: id, itemId: undefined };
	const itemId = id.slice(separator + 1);
	return { callId: id.slice(0, separator), itemId: itemId.length > 0 ? itemId : undefined };
}

/** 助手消息回放成输入项；只有思考项的轮次整轮丢弃，孤立的 reasoning 项会被端点拒绝。 */
function toInput(messages: readonly LlmMessage[], supportsImages: boolean): readonly unknown[] {
	const input: unknown[] = [];

	for (const message of messages) {
		switch (message.role) {
			case "user":
				input.push({ role: "user", content: toUserContent(message, supportsImages) });
				break;
			case "assistant": {
				const items: { readonly item: unknown; readonly reasoning: boolean }[] = [];
				for (const block of message.content) {
					if (block.type === "thinking") {
						const reasoning = parseReasoningItem(block.signature);
						if (reasoning !== undefined) items.push({ item: reasoning, reasoning: true });
					} else if (block.type === "text") {
						if (block.text.length === 0) continue;
						items.push({
							item: {
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: block.text, annotations: [] }],
								status: "completed",
							},
							reasoning: false,
						});
					} else {
						const { callId, itemId } = splitToolCallId(block.id);
						items.push({
							item: {
								type: "function_call",
								call_id: callId,
								name: block.name,
								arguments: JSON.stringify(block.arguments),
								...(itemId === undefined ? {} : { id: itemId }),
							},
							reasoning: false,
						});
					}
				}
				if (items.some((entry) => !entry.reasoning)) {
					for (const entry of items) input.push(entry.item);
				}
				break;
			}
			case "toolResult": {
				const { callId } = splitToolCallId(message.toolCallId);
				input.push({ type: "function_call_output", call_id: callId, output: message.content });
				break;
			}
		}
	}

	return input;
}

/**
 * 用户消息的内容。
 *
 * 图片按 Responses 的输入分片发送；模型不接受图片时用文本说明代替。只有图片、没有文字时
 * 补一句说明，避免端点收到一个没有文字锚点的内容数组。
 */
function toUserContent(message: LlmUserMessage, supportsImages: boolean): readonly unknown[] {
	if (typeof message.content === "string") {
		return [{ type: "input_text", text: message.content }];
	}

	const parts: unknown[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({ type: "input_text", text: block.text });
			continue;
		}
		parts.push(
			supportsImages
				? {
						type: "input_image",
						detail: "auto",
						image_url: `data:${block.mimeType};base64,${block.data}`,
					}
				: { type: "input_text", text: "(image omitted: model does not support images)" },
		);
	}

	if (!parts.some((part) => isInputText(part))) {
		parts.unshift({ type: "input_text", text: "(see attached image)" });
	}
	return parts;
}

function isInputText(part: unknown): boolean {
	return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "input_text";
}

/**
 * 读回本适配器保存的思考项。
 *
 * 会话里也可能留有其他协议的思考签名（例如切换模型之后），它们不是 JSON 或不是 reasoning
 * 项；这些一律跳过，不能让一段旧的签名把整轮请求卡死。
 */
function parseReasoningItem(signature: string | undefined): Record<string, unknown> | undefined {
	if (signature === undefined) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

	const item = parsed as Record<string, unknown>;
	return item["type"] === "reasoning" ? item : undefined;
}

function joinText(parts: readonly WireTextPart[] | undefined, separator: string): string {
	if (parts === undefined) return "";
	return parts.map((part) => part.text ?? part.refusal ?? "").join(separator);
}

function toUsage(usage: WireUsage): LlmUsage {
	// OpenAI 的 input_tokens 已包含缓存读取与写入，这里拆成与内部用量一致的净输入
	const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
	const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
	const input = Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite);
	const output = usage.output_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: usage.total_tokens ?? input + output + cacheRead + cacheWrite,
	};
}

function stopReasonOf(
	status: string,
	reason: string | undefined,
	content: readonly LlmContentBlock[],
): { readonly stopReason: LlmStopReason; readonly errorMessage: string | undefined } {
	if (status === "incomplete") {
		if (reason === "max_output_tokens") return { stopReason: "length", errorMessage: undefined };
		return {
			stopReason: "error",
			errorMessage:
				reason === undefined
					? "the response was incomplete without a provider reason"
					: `the response was incomplete: ${reason}`,
		};
	}
	if (status === "failed" || status === "cancelled") {
		return { stopReason: "error", errorMessage: `the response ended with status ${status}` };
	}
	return {
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		errorMessage: undefined,
	};
}
