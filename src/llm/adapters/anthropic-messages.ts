import type { ModelEntry, ProviderEntry } from "../../config/models-file.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../client.ts";
import { resolveApiKey } from "../api-keys.ts";
import { providerEffortValue } from "../effort.ts";
import { postSse } from "../http.ts";
import type { LlmContentBlock, LlmStopReason, LlmUsage } from "../messages.ts";
import type { RetryPolicy } from "../retry.ts";
import { ContentAccumulator } from "./content-accumulator.ts";
import { createLlmStream, joinUrl } from "./stream-runner.ts";

/**
 * Anthropic 的 Messages 协议。
 *
 * 与对话补全协议的两处结构性差别：一是内容以块数组表达，文本、思考、工具调用各有块类型，
 * 流里的下标直接就是块下标；二是工具结果必须作为 user 消息里的 tool_result 块回传，所以
 * 连续的工具结果要合并成一条消息，否则会散成好几轮。
 */

/** 这套协议的版本头是必填的，端点若不接受默认值可在 models.json 的 headers 里覆盖。 */
const DEFAULT_API_VERSION = "2023-06-01";

interface WireBlock {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly signature?: string;
	readonly id?: string;
	readonly name?: string;
	readonly input?: unknown;
	readonly tool_use_id?: string;
	readonly content?: string;
	readonly is_error?: boolean;
}

interface WireMessage {
	readonly role: "user" | "assistant";
	readonly content: readonly WireBlock[];
}

interface StreamEvent {
	readonly type: string;
	readonly index?: number;
	readonly message?: { readonly model?: string; readonly usage?: WireUsage };
	readonly content_block?: WireBlock;
	readonly delta?: {
		readonly type?: string;
		readonly text?: string;
		readonly thinking?: string;
		readonly signature?: string;
		readonly partial_json?: string;
		readonly stop_reason?: string | null;
	};
	readonly usage?: WireUsage;
	readonly error?: { readonly type?: string; readonly message?: string };
}

/** 这套协议的用量字段名与内部形状不同，且分散在开始与收尾两个事件里。 */
interface WireUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly cache_read_input_tokens?: number;
	readonly cache_creation_input_tokens?: number;
}

export class AnthropicMessagesClient implements LlmClient {
	readonly api = "anthropic-messages";
	readonly #provider: ProviderEntry;
	readonly #model: ModelEntry;
	readonly #policy: RetryPolicy;

	constructor(provider: ProviderEntry, model: ModelEntry, policy: RetryPolicy) {
		this.#provider = provider;
		this.#model = model;
		this.#policy = policy;
	}

	stream(request: LlmRequest): LlmStream {
		return createLlmStream(request, (emit) => this.#run(request, emit));
	}

	async #run(request: LlmRequest, emit: (event: LlmEvent) => void): Promise<LlmResult> {
		// 密钥每次请求现取：command 形式的密钥可能是短期有效的，启动时取一次会在长会话里过期
		const apiKey = await resolveApiKey(this.#provider.apiKey, request.signal);
		const accumulator = new ContentAccumulator();
		let stopReason: string | undefined;
		let usage: Partial<TokenCounts> = {};
		let responseModel = this.#model.id;

		await postSse(
			{
				url: joinUrl(this.#model.baseUrl, "/v1/messages"),
				headers: {
					"anthropic-version": DEFAULT_API_VERSION,
					...this.#provider.headers,
					...this.#model.headers,
					...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
				},
				body: this.#buildBody(request),
				signal: request.signal,
			},
			(data) => {
				let event: StreamEvent;
				try {
					event = JSON.parse(data) as StreamEvent;
				} catch {
					return;
				}
				if (event.type === "error") {
					throw new Error(`端点返回错误：${event.error?.message ?? event.error?.type ?? "未说明"}`);
				}
				if (event.type === "message_start") {
					if (event.message?.model !== undefined) responseModel = event.message.model;
					usage = { ...usage, ...countsOf(event.message?.usage) };
					return;
				}
				if (event.type === "message_delta") {
					if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== null) {
						stopReason = event.delta.stop_reason;
					}
					// 输出用量只在收尾事件里给出
					usage = { ...usage, ...countsOf(event.usage) };
					return;
				}

				const index = event.index;
				if (index === undefined) return;
				applyEvent(event, index, accumulator, emit);
			},
			this.#policy,
		);

		if (stopReason === undefined) {
			// 没有结束原因的响应可能被截断过；当成完成会让残缺的工具调用被执行
			throw new Error("响应没有给出结束原因，可能是连接提前断开");
		}

		return {
			content: accumulator.blocks(),
			usage: toUsage(usage),
			stopReason: toStopReason(stopReason),
			errorMessage: undefined,
			model: responseModel,
		};
	}

	#buildBody(request: LlmRequest): Record<string, unknown> {
		if (request.maxTokens === undefined) {
			// 这套协议要求必须给出输出上限，凭空选一个数字会让花费与截断行为变得不可预期
			throw new Error(
				`模型 ${this.#provider.id}/${this.#model.id} 没有声明 maxTokens，` +
					"这套协议要求必须给出输出上限，请在 models.json 里补上",
			);
		}

		const body: Record<string, unknown> = {
			model: request.model,
			system: request.system,
			messages: toWireMessages(request),
			max_tokens: request.maxTokens,
			stream: true,
		};
		if (request.tools.length > 0) {
			body["tools"] = request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			}));
		}
		if (request.effort !== undefined) {
			// 思考等级按「自适应思考」的形式发送；不接受这个字段的模型会明确报错，
			// 把 reasoning_effort 设为 off 即可，不做静默降级
			body["thinking"] = {
				type: "adaptive",
				effort: providerEffortValue(request.effort, this.#model.thinkingLevelMap),
			};
		}
		return body;
	}
}

function applyEvent(
	event: StreamEvent,
	index: number,
	accumulator: ContentAccumulator,
	emit: (event: LlmEvent) => void,
): void {
	switch (event.type) {
		case "content_block_start": {
			const block = event.content_block;
			if (block?.type === "tool_use") {
				if (accumulator.startToolCall(index, block.id ?? "", block.name ?? "")) {
					emit({ type: "tool_call_start", index, id: block.id ?? "", name: block.name ?? "" });
				}
				return;
			}
			// 文本与思考块在首个增量到来时自动建出来，这里不必处理
			return;
		}
		case "content_block_delta": {
			const delta = event.delta;
			if (delta?.type === "text_delta" && typeof delta.text === "string") {
				accumulator.appendText(index, delta.text);
				emit({ type: "text_delta", text: delta.text });
				return;
			}
			if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
				accumulator.appendThinking(index, delta.thinking);
				emit({ type: "reasoning_delta", text: delta.thinking });
				return;
			}
			if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
				accumulator.setThinkingSignature(index, delta.signature);
				return;
			}
			if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
				accumulator.appendToolArguments(index, delta.partial_json);
				emit({ type: "tool_call_delta", index, argsJson: delta.partial_json });
			}
			return;
		}
		case "content_block_stop": {
			accumulator.finish(index);
			emit({ type: "tool_call_end", index });
			return;
		}
		default:
			return;
	}
}

interface TokenCounts {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

function countsOf(usage: WireUsage | undefined): Partial<TokenCounts> {
	if (usage === undefined) return {};
	return {
		...(usage.input_tokens === undefined ? {} : { input: usage.input_tokens }),
		...(usage.output_tokens === undefined ? {} : { output: usage.output_tokens }),
		...(usage.cache_read_input_tokens === undefined ? {} : { cacheRead: usage.cache_read_input_tokens }),
		...(usage.cache_creation_input_tokens === undefined
			? {}
			: { cacheWrite: usage.cache_creation_input_tokens }),
	};
}

function toUsage(counts: Partial<TokenCounts>): LlmUsage | undefined {
	if (Object.keys(counts).length === 0) return undefined;
	const input = counts.input ?? 0;
	const output = counts.output ?? 0;
	const cacheRead = counts.cacheRead ?? 0;
	const cacheWrite = counts.cacheWrite ?? 0;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function toStopReason(stopReason: string): LlmStopReason {
	switch (stopReason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}

function toWireMessages(request: LlmRequest): WireMessage[] {
	const messages: WireMessage[] = [];
	let pendingResults: WireBlock[] = [];

	const flushResults = (): void => {
		if (pendingResults.length === 0) return;
		messages.push({ role: "user", content: pendingResults });
		pendingResults = [];
	};

	for (const message of request.messages) {
		switch (message.role) {
			case "user":
				flushResults();
				messages.push({ role: "user", content: [{ type: "text", text: message.content }] });
				break;
			case "assistant": {
				flushResults();
				const content = toWireAssistant(message.content);
				// 内容为空的助手消息这套协议不接受，且它也不携带任何信息
				if (content.length > 0) messages.push({ role: "assistant", content });
				break;
			}
			case "toolResult":
				pendingResults.push({
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: message.content,
					is_error: message.isError,
				});
				break;
		}
	}
	flushResults();
	return messages;
}

function toWireAssistant(content: readonly LlmContentBlock[]): WireBlock[] {
	const blocks: WireBlock[] = [];
	for (const block of content) {
		switch (block.type) {
			case "text":
				if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
				break;
			case "thinking":
				// 回传思考块必须带签名，缺签名的会被拒；宁可不回传也不要发一个必然失败的请求
				if (block.signature !== undefined) {
					blocks.push({ type: "thinking", thinking: block.text, signature: block.signature });
				}
				break;
			case "toolCall":
				blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
				break;
		}
	}
	return blocks;
}
