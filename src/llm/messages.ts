/**
 * 会话与模型之间往来的消息形状。
 *
 * 单独成模块是为了断开依赖环：会话要存消息、驱动要发消息、工具结果也是消息，但这三方
 * 互不依赖，只共用这一份形状。
 */

export interface LlmTextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface LlmThinkingBlock {
	readonly type: "thinking";
	readonly text: string;
	/**
	 * provider 要求的校验签名。
	 *
	 * 开启思考的模型在多轮工具调用里要求把思考块连同签名原样带回，缺了签名后续请求会被拒。
	 * 不需要签名的端点这里为空。
	 */
	readonly signature?: string;
}

export interface LlmToolCallBlock {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	/** 流式参数没能拼成合法 JSON 时的原因；带着它才能让模型知道该重发什么 */
	readonly argumentsError?: string;
}

export type LlmContentBlock = LlmTextBlock | LlmThinkingBlock | LlmToolCallBlock;

export interface LlmUserMessage {
	readonly role: "user";
	readonly content: string;
}

export interface LlmAssistantMessage {
	readonly role: "assistant";
	readonly content: readonly LlmContentBlock[];
}

export interface LlmToolResultMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: string;
	readonly isError: boolean;
}

export type LlmMessage = LlmUserMessage | LlmAssistantMessage | LlmToolResultMessage;

export interface LlmUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

export type LlmStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** 取助手消息里的文本，多段之间用空行分隔。 */
export function assistantText(message: LlmAssistantMessage): string {
	return message.content
		.filter((block): block is LlmTextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

/** 取助手消息里的工具调用。 */
export function assistantToolCalls(message: LlmAssistantMessage): readonly LlmToolCallBlock[] {
	return message.content.filter((block): block is LlmToolCallBlock => block.type === "toolCall");
}
