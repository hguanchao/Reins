import type { LlmEvent, LlmRequest, LlmResult } from "../client.ts";
import { resolveApiKey } from "../api-keys.ts";
import { providerEffortValue } from "../effort.ts";
import type { LlmContentBlock, LlmStopReason, LlmUsage, LlmUserMessage } from "../messages.ts";
import { ContentAccumulator } from "./content-accumulator.ts";
import { ProtocolClient } from "./protocol-client.ts";
import {
	IMAGE_ATTACHMENT_NOTICE,
	IMAGE_OMITTED_PLACEHOLDER,
} from "./stream-runner.ts";

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
	/** 另外两种常见的推理内容字段名 */
	readonly reasoning?: string | null;
	readonly reasoning_text?: string | null;
	readonly tool_calls?: readonly {
		readonly index?: number;
		readonly id?: string;
		readonly function?: { readonly name?: string; readonly arguments?: string };
	}[];
}

/** 用量。字段在各个兼容端点之间并不统一，能读到的都列在这里。 */
interface WireUsage {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly total_tokens?: number;
	readonly prompt_tokens_details?: { readonly cached_tokens?: number } | null;
	/** DeepSeek 系把缓存命中平铺在这里 */
	readonly prompt_cache_hit_tokens?: number;
	/** Kimi 系放在顶层 */
	readonly cached_tokens?: number;
	/** OpenRouter 系给出的缓存写入 */
	readonly cache_write_tokens?: number;
}

/**
 * 流里的一个分片。
 *
 * 可选字段一律允许 null：兼容端点习惯把「没有」写成 null（`"usage": null` 每帧都带），
 * 只判 undefined 会一头撞进去。
 */
interface StreamChunk {
	readonly model?: string | null;
	readonly choices?: readonly {
		readonly delta?: StreamDelta | null;
		readonly finish_reason?: string | null;
		/** Moonshot 系把用量放在 choice 里而不是 chunk 上 */
		readonly usage?: WireUsage | null;
	}[];
	readonly usage?: WireUsage | null;
	/** 出错时服务端会回一个 error 对象 */
	readonly error?: { readonly message?: string; readonly type?: string } | null;
}

export class OpenAiCompletionsClient extends ProtocolClient {
	readonly api = "openai-completions";

	protected async runProtocol(
		request: LlmRequest,
		emit: (event: LlmEvent) => void,
		accumulator: ContentAccumulator,
	): Promise<LlmResult> {
		// 密钥每次请求现取：command 形式的密钥可能是短期有效的，启动时取一次会在长会话里过期
		const apiKey = await resolveApiKey(this.provider.apiKey, request.signal);
		let finishReason: string | undefined;
		let usage: LlmUsage | undefined;
		let responseModel = this.model.id;
		/** 是否见到了 [DONE] */
		let done = false;
		/** 端点不给 tool_call.index 时按出现顺序分配的计数器 */
		const nextImplicitIndex = { value: 0 };

		await this.postStream(
			request,
			"/chat/completions",
			apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
			() => done || finishReason !== undefined,
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
				// 兼容端点常把没有的字段写成 null：这里一律按「没给」处理，别去读它的属性
				if (chunk.error != null) {
					throw new Error(`endpoint returned an error: ${chunk.error.message ?? chunk.error.type ?? "no details"}`);
				}
				if (typeof chunk.model === "string") responseModel = chunk.model;
				if (chunk.usage != null) usage = toUsage(chunk.usage);

				const choice = chunk.choices?.[0];
				if (choice === undefined) return;
				// 用量通常挂在 chunk 上；Moonshot 系把它挂在 choice 里
				if (usage === undefined && choice.usage != null) usage = toUsage(choice.usage);
				if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
					finishReason = choice.finish_reason;
				}
				if (choice.delta != null) applyDelta(choice.delta, accumulator, emit, nextImplicitIndex);
			},
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

	buildBody(request: LlmRequest): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: toWireMessages(request, this.model.input.includes("image")),
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
		// 字段名由模型声明：新的 OpenAI 端点只认 max_completion_tokens
		if (request.maxTokens !== undefined) body[this.model.maxTokensField] = request.maxTokens;
		// 只有声明支持的端点才发这个字段：严格校验未知字段的网关会因此直接报错
		if (this.provider.promptCacheKey && request.cacheKey !== undefined) {
			body["prompt_cache_key"] = request.cacheKey;
		}
		if (request.effort !== undefined) {
			body["reasoning_effort"] = providerEffortValue(request.effort, this.model.thinkingLevelMap);
		}
		return body;
	}
}

function applyDelta(
	delta: StreamDelta,
	accumulator: ContentAccumulator,
	emit: (event: LlmEvent) => void,
	nextImplicitIndex: { value: number },
): void {
	const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
	if (typeof reasoning === "string" && reasoning.length > 0) {
		accumulator.appendThinking(THINKING_INDEX, reasoning);
		emit({ type: "reasoning_delta", text: reasoning });
	}

	if (typeof delta.content === "string" && delta.content.length > 0) {
		accumulator.appendText(TEXT_INDEX, delta.content);
		emit({ type: "text_delta", text: delta.content });
	}

	for (const call of delta.tool_calls ?? []) {
		// 兼容端点可能不给 index：那时不能一律用 0，否则同一分片里的第二个调用会覆盖第一个
		// 的 id 与名称，两段参数还拼进同一个缓冲区，最终两个调用一起丢。按出现顺序分配。
		let index: number;
		if (typeof call.index === "number") {
			index = TOOL_CALL_BASE + call.index;
		} else {
			index = TOOL_CALL_BASE + nextImplicitIndex.value;
			nextImplicitIndex.value += 1;
		}
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
			parts.push({ type: "text", text: IMAGE_OMITTED_PLACEHOLDER });
		}
	}

	if (!parts.some((part) => part.type === "text")) {
		parts.unshift({ type: "text", text: IMAGE_ATTACHMENT_NOTICE });
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

/**
 * 用量映射。
 *
 * 缓存命中的字段各家叫法不同，能认的都认一遍；`prompt_tokens` 里本来就含着缓存那部分，
 * 拆出来才算得对金额与命中率——这与 responses 适配器是同一个口径。
 */
function toUsage(usage: WireUsage): LlmUsage {
	const cacheRead =
		usage.prompt_tokens_details?.cached_tokens ??
		usage.prompt_cache_hit_tokens ??
		usage.cached_tokens ??
		0;
	const cacheWrite = usage.cache_write_tokens ?? 0;
	const prompt = usage.prompt_tokens ?? 0;
	const input = Math.max(0, prompt - cacheRead - cacheWrite);
	const output = usage.completion_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		// 端点不给 total 时按四项之和补齐,与 responses 协议同一口径:
		// total 反映这一轮上下文有多大,缓存读写也算占用
		total: usage.total_tokens ?? input + output + cacheRead + cacheWrite,
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
