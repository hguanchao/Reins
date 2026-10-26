import { describeError } from "../../shared/describe-error.ts";
import type { LlmContentBlock, LlmToolCallBlock } from "../messages.ts";

/**
 * 把流式分块拼成完整的内容。
 *
 * 分块按「内容下标」归位：同一个下标上的多次增量属于同一个块，下标由各适配器自己指派——
 * 它只需要在整轮响应内稳定且互不重复。文本与思考块在首次追加时自动建出来，工具调用需要
 * 先记下 id 与名称，所以单独有一个开始方法。
 *
 * 工具参数以 JSON 文本增量到达，只能在块结束时才尝试解析：中途的任何时刻它都可能是不完整的。
 */
export class ContentAccumulator {
	readonly #blocks: (LlmContentBlock | undefined)[] = [];
	/** 工具参数的原始 JSON 文本，按内容下标累积 */
	readonly #argumentJson = new Map<number, string>();
	/** 已经收尾过的工具调用块：收尾会消费掉参数文本，重复收尾会把参数覆盖成空对象 */
	readonly #settled = new Set<number>();

	appendText(index: number, text: string): void {
		const block = this.#blocks[index];
		if (block?.type === "text") {
			this.#blocks[index] = { type: "text", text: block.text + text };
			return;
		}
		this.#blocks[index] = { type: "text", text };
	}

	/**
	 * 用最终文本覆盖某个下标上的文本块。
	 *
	 * 有些协议只在块结束时给出完整文本，中途没有可靠的增量；收尾时以最终值为准，
	 * 既补上缺失的增量，也纠正重复或乱序的分片。
	 */
	setText(index: number, text: string): void {
		this.#blocks[index] = { type: "text", text };
	}

	appendThinking(index: number, text: string): void {
		const block = this.#blocks[index];
		if (block?.type === "thinking") {
			this.#blocks[index] = { type: "thinking", text: block.text + text, ...signatureOf(block) };
			return;
		}
		this.#blocks[index] = { type: "thinking", text };
	}

	/** 用最终文本覆盖某个下标上的思考块；已有签名继续保留。 */
	setThinkingText(index: number, text: string): void {
		const block = this.#blocks[index];
		const signature = block?.type === "thinking" ? signatureOf(block) : {};
		this.#blocks[index] = { type: "thinking", text, ...signature };
	}

	/**
	 * 记下工具调用的 id 与名称。返回是否是首次出现，便于适配器只发一次开始事件。
	 *
	 * 部分端点把 id、名称、参数拆在几个分片里送来，所以这里按已出现的信息补齐而不是重置。
	 */
	startToolCall(index: number, id: string, name: string): boolean {
		const block = this.#blocks[index];
		if (block?.type === "toolCall") {
			this.#blocks[index] = {
				type: "toolCall",
				id: id.length > 0 ? id : block.id,
				name: name.length > 0 ? name : block.name,
				arguments: block.arguments,
			};
			return false;
		}
		this.#blocks[index] = { type: "toolCall", id, name, arguments: {} };
		return true;
	}

	appendToolArguments(index: number, json: string): void {
		if (this.#blocks[index]?.type !== "toolCall") return;
		this.#argumentJson.set(index, (this.#argumentJson.get(index) ?? "") + json);
	}

	/** 思考块的校验签名。带工具调用的多轮对话里 provider 会要求把签名原样带回。 */
	setThinkingSignature(index: number, signature: string): void {
		const block = this.#blocks[index];
		if (block?.type !== "thinking") return;
		this.#blocks[index] = { type: "thinking", text: block.text, signature };
	}

	/**
	 * 记下一个被加密的思考块。
	 *
	 * 这种块没有增量、也没有文本：内容整体加密后一次给出，必须原样回传才能让后续请求成立。
	 */
	setRedactedThinking(index: number, data: string): void {
		this.#blocks[index] = { type: "redactedThinking", data };
	}

	/**
	 * 收尾一个块。工具参数的 JSON 在这里解析成对象。
	 *
	 * `json` 是协议在块结束时给出的完整参数。给了就以它为准：中途的分片可能缺失或乱序，
	 * 最终值才是端点认定的结果。未给出时用累积到的分片。
	 *
	 * 解析失败不抛错：原因记在块上交回给模型，它看到具体的错误才能改；直接中断整轮对话只会
	 * 丢掉它已经想好的部分。
	 */
	finish(index: number, json?: string): void {
		const block = this.#blocks[index];
		if (block?.type !== "toolCall" || this.#settled.has(index)) return;
		this.#settled.add(index);

		const parsed = parseToolArguments(json ?? this.#argumentJson.get(index) ?? "");
		this.#argumentJson.delete(index);
		this.#blocks[index] = settleToolCall(block, parsed);
	}

	/** 某个下标上是不是工具调用块。块收尾时据此决定要不要发结束事件。 */
	isToolCall(index: number): boolean {
		return this.#blocks[index]?.type === "toolCall";
	}

	/** 收尾所有工具调用块。用于协议不单独给出块结束信号的端点。 */
	finishAll(): void {
		for (let index = 0; index < this.#blocks.length; index += 1) {
			if (this.#blocks[index]?.type === "toolCall") this.finish(index);
		}
	}

	/** 当前已拼出的内容，按内容下标顺序，跳过没有出现的下标。 */
	blocks(): readonly LlmContentBlock[] {
		const result: LlmContentBlock[] = [];
		for (const block of this.#blocks) {
			if (block !== undefined) result.push(block);
		}
		return result;
	}

	/**
	 * 这一轮有没有实际产出。
	 *
	 * 只有思考块不算产出：模型想了却没说出任何东西，交出去就是一轮空白回答。空响应在网关
	 * 上并不罕见，静默当成功会让人以为模型就是不想说话。
	 */
	hasOutput(): boolean {
		return this.#blocks.some(
			(block) =>
				block !== undefined &&
				(block.type === "toolCall" ||
					(block.type === "text" && block.text.trim().length > 0)),
		);
	}
}

function signatureOf(block: { readonly signature?: string }): { readonly signature?: string } {
	return block.signature === undefined ? {} : { signature: block.signature };
}

interface ParsedToolArguments {
	readonly arguments: Record<string, unknown>;
	readonly argumentsError?: string;
}

/** 解析工具参数的 JSON，失败时给出可读原因而不抛错。 */
export function parseToolArguments(json: string): ParsedToolArguments {
	if (json.trim().length === 0) return { arguments: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		const reason = describeError(error);
		return { arguments: {}, argumentsError: `tool arguments are not valid JSON: ${reason}` };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { arguments: {}, argumentsError: "tool arguments must be a JSON object" };
	}
	return { arguments: parsed as Record<string, unknown> };
}

function settleToolCall(block: LlmToolCallBlock, parsed: ParsedToolArguments): LlmToolCallBlock {
	if (parsed.argumentsError === undefined) {
		return { type: "toolCall", id: block.id, name: block.name, arguments: parsed.arguments };
	}
	return {
		type: "toolCall",
		id: block.id,
		name: block.name,
		arguments: parsed.arguments,
		argumentsError: parsed.argumentsError,
	};
}
