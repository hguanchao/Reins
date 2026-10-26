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

/**
 * 被安全策略加密的思考块。
 *
 * Anthropic 在命中安全过滤时把思考内容整体加密后返回；带思考的多轮工具调用里必须把它
 * 原样回传，否则后续请求会被拒或丢失思考上下文。内容对我们是不可读的，只能原样搬运。
 */
export interface LlmRedactedThinkingBlock {
	readonly type: "redactedThinking";
	/** 端点给出的加密数据 */
	readonly data: string;
}

export type LlmContentBlock =
	| LlmTextBlock
	| LlmThinkingBlock
	| LlmToolCallBlock
	| LlmRedactedThinkingBlock;

/** 用户消息里的图片。数据是 base64，不带 data URL 前缀。 */
export interface LlmImageBlock {
	readonly type: "image";
	readonly data: string;
	/** 如 image/png、image/jpeg、image/gif、image/webp */
	readonly mimeType: string;
	/** 附件文件名；只用于界面与历史显示，不进入请求体 */
	readonly name?: string;
}

/** 用户消息能携带的内容。文本与图片可以混排。 */
export type LlmUserContentBlock = LlmTextBlock | LlmImageBlock;

export interface LlmUserMessage {
	readonly role: "user";
	/** 纯文本可以省略块数组；带图片时必须用块数组 */
	readonly content: string | readonly LlmUserContentBlock[];
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

/** 取用户消息里的文本；图片不参与。 */
export function userText(message: LlmUserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is LlmTextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

/** 取用户消息里的图片。 */
export function userImages(message: LlmUserMessage): readonly LlmImageBlock[] {
	if (typeof message.content === "string") return [];
	return message.content.filter((block): block is LlmImageBlock => block.type === "image");
}

/** 取助手消息里的工具调用。 */
export function assistantToolCalls(message: LlmAssistantMessage): readonly LlmToolCallBlock[] {
	return message.content.filter((block): block is LlmToolCallBlock => block.type === "toolCall");
}
