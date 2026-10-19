import type { ReasoningEffort } from "./effort.ts";
import type { EventStream } from "./event-stream.ts";
import type { LlmContentBlock, LlmMessage, LlmStopReason, LlmUsage } from "./messages.ts";

/**
 * 模型客户端接缝。
 *
 * 上层只认识这个接口：一次请求换回一串增量事件，外加一个最终结果。适配器负责把各家的线上
 * 协议翻译过来，而重试策略、会话记录、提示词组装都不在这里——那些是宿主的决定。
 */

export interface LlmToolDeclaration {
	readonly name: string;
	readonly description: string;
	/** 工具参数的 JSON Schema。客户端只负责原样序列化，不解释它的内容。 */
	readonly parameters: unknown;
}

export interface LlmRequest {
	/** provider 内声明的模型 id */
	readonly model: string;
	readonly system: string;
	readonly messages: readonly LlmMessage[];
	readonly tools: readonly LlmToolDeclaration[];
	readonly maxTokens: number | undefined;
	/** 已收敛到模型支持的等级；undefined 表示不发送任何思考参数 */
	readonly effort: ReasoningEffort | undefined;
	/**
	 * 这段对话的稳定标识。
	 *
	 * 端点支持提示词缓存时用它把同一段对话路由到同一片缓存：标识不变，前缀的缓存才可能命中。
	 */
	readonly cacheKey?: string;
	readonly signal: AbortSignal;
}

/** 流式过程中的增量。只用于实时显示，最终结果以 LlmResult 为准。 */
export type LlmEvent =
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "reasoning_delta"; readonly text: string }
	| { readonly type: "tool_call_start"; readonly index: number; readonly id: string; readonly name: string }
	| { readonly type: "tool_call_delta"; readonly index: number; readonly argsJson: string }
	| { readonly type: "tool_call_end"; readonly index: number };

export interface LlmResult {
	/** 助手这一轮产出的完整内容，含文本与工具调用 */
	readonly content: readonly LlmContentBlock[];
	readonly usage: LlmUsage | undefined;
	readonly stopReason: LlmStopReason;
	/** stopReason 为 error 时的原因；其余情况为 undefined */
	readonly errorMessage: string | undefined;
	/** 实际应答的模型。端点改写请求模型时以它为准。 */
	readonly model: string;
}

export interface LlmStream extends AsyncIterable<LlmEvent> {
	/** 最终结果。与迭代可同时进行。 */
	result(): Promise<LlmResult>;
}

export interface LlmClient {
	/** 线上协议名，对应 providers.json 里的 api 字段 */
	readonly api: string;
	/**
	 * 发起一次流式请求。
	 *
	 * 这个调用本身不抛异常：连接建立之后的任何失败都以 stopReason 为 error 或 aborted 的
	 * 结果交回，这样调用方拿到的事件序列永远是完整的，不会出现「拿到流之后又炸掉」。
	 */
	stream(request: LlmRequest): LlmStream;
}

export type { EventStream };
