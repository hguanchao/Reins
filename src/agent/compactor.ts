import { eastAsianWidth } from "get-east-asian-width";

import { computeCost, type ModelEntry } from "../config/providers-file.ts";
import type { LlmClient } from "../llm/client.ts";
import { assistantText, type LlmMessage, type LlmUsage } from "../llm/messages.ts";

/**
 * 上下文压缩。
 *
 * 上下文长到接近模型上限时，把较早的消息交给压缩模型换回一份交接摘要：接下来的请求带的是
 * 摘要加上最近若干条消息。这里只回答三件事——该不该压、压前面多少条、摘要怎么来；把结果写进
 * 会话由驱动做，于是「压缩了什么」在历史里查得到。
 *
 * 触发看真实的上下文规模：提供方每轮回报的用量最准，没有回报时才退回按字符估算，估算一律
 * 往大处算——早压缩只损失一点细节，晚压缩会被端点直接拒绝。
 */

/** 上下文用到上限的这个比例就压缩：留出余量给这一轮的输出与随后新增的内容。 */
const COMPACT_RATIO = 0.8;

/** 压缩后保留最近这一比例的上下文原文，更早的部分交给摘要。 */
const KEEP_RATIO = 0.25;

/** 每条消息的固定开销（角色标记与协议外壳），按条计一点，免得整体低估。 */
const MESSAGE_OVERHEAD_TOKENS = 8;

const SUMMARY_SYSTEM = `You compress a conversation between a coding assistant and its user into a handover summary that lets the work continue.

Rules:
- Use only the given conversation. Do not speculate or add anything it does not contain.
- Keep: the current goal, changes and conclusions already reached, what is still unfinished, the files and paths involved, the key commands that ran and how they turned out, and the user's explicit requirements and prohibitions.
- Drop: pleasantries, repeated confirmations, and file contents that can simply be read again.
- Write it as a bulleted list in English, under 500 words.`;

const SUMMARY_INSTRUCTION = "Compress the conversation above into a handover summary.";

export interface CompactorDeps {
	readonly client: LlmClient;
	readonly provider: string;
	readonly model: ModelEntry;
	/** 上下文上限：providers.json 的 contextWindow 或 config.toml 的 context_window */
	readonly contextWindow: number;
	readonly maxTokens: number | undefined;
}

export type CompactionResult =
	| {
			readonly ok: true;
			readonly summary: string;
			readonly usage: LlmUsage | undefined;
			/** 这次摘要请求的金额。摘要可能用另一个模型，单价按它自己算 */
			readonly cost: number | undefined;
	  }
	| { readonly ok: false; readonly message: string };

export class Compactor {
	readonly #deps: CompactorDeps;

	constructor(deps: CompactorDeps) {
		this.#deps = deps;
	}

	/** 产出摘要的模型标识，写进会话时要记下来。 */
	get provider(): string {
		return this.#deps.provider;
	}

	get model(): string {
		return this.#deps.model.id;
	}

	/** 该不该压缩。tokens 是当前上下文的规模。 */
	shouldCompact(tokens: number): boolean {
		return tokens >= this.#deps.contextWindow * COMPACT_RATIO;
	}

	/**
	 * 要摘要掉前面多少条消息；0 表示没有可压缩的部分。
	 *
	 * 从后往前凑到保留额度为止，因此最近的内容一定是原文。边界不能落在工具结果上：它对应的
	 * 那次调用如果被摘要掉，端点会因为「没有对应调用的工具结果」拒绝整个请求。
	 */
	plan(messages: readonly LlmMessage[]): number {
		const budget = this.#deps.contextWindow * KEEP_RATIO;
		let keep = 0;
		let total = 0;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			total += estimateMessageTokens(messages[index]);
			if (total > budget && keep > 0) break;
			keep += 1;
		}

		let cut = messages.length - keep;
		while (cut > 0 && messages[cut].role === "toolResult") cut -= 1;
		return cut;
	}

	/**
	 * 让压缩模型写摘要。
	 *
	 * 失败一律如实交回，由调用方决定怎么显示：拿一份半截的摘要替换掉真实历史，比不压缩危险
	 * 得多——模型会以为那就是全部经过。
	 */
	async summarize(messages: readonly LlmMessage[], signal: AbortSignal): Promise<CompactionResult> {
		const stream = this.#deps.client.stream({
			model: this.#deps.model.id,
			system: SUMMARY_SYSTEM,
			messages: [...messages, { role: "user", content: SUMMARY_INSTRUCTION }],
			tools: [],
			maxTokens: this.#deps.model.maxTokens ?? this.#deps.maxTokens,
			// 写摘要不是需要思考的活：等级一律不发，交给端点默认，省下的开销留给主对话
			effort: undefined,
			signal,
		});

		const result = await stream.result();
		if (result.stopReason === "error") {
			return { ok: false, message: result.errorMessage ?? "Compaction request failed" };
		}
		if (result.stopReason === "aborted") return { ok: false, message: "Compaction was aborted" };
		if (result.stopReason === "length") {
			return { ok: false, message: "The summary hit the output limit and was discarded; raise max_tokens for this model and try again" };
		}

		const summary = assistantText({ role: "assistant", content: result.content }).trim();
		if (summary.length === 0) return { ok: false, message: "The compaction model returned nothing" };
		return {
			ok: true,
			summary,
			usage: result.usage,
			cost: result.usage === undefined ? undefined : computeCost(this.#deps.model.cost, result.usage),
		};
	}
}

/** 一段上下文的规模估算。提供方没有回报用量时用它——宁可估大，早压缩比被拒绝好。 */
export function estimateTokens(messages: readonly LlmMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateMessageTokens(message);
	return total;
}

function estimateMessageTokens(message: LlmMessage): number {
	switch (message.role) {
		case "user":
			return roughTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
		case "assistant": {
			let total = MESSAGE_OVERHEAD_TOKENS;
			for (const block of message.content) {
				if (block.type === "toolCall") total += roughTokens(`${block.name}${JSON.stringify(block.arguments)}`);
				else total += roughTokens(block.text);
			}
			return total;
		}
		case "toolResult":
			return roughTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
	}
}

/**
 * 按字符估 token。
 *
 * 中日韩文字与全角符号通常一个字一个 token，其余文字约四个字符一个 token。这不是精确计数
 * ——精确计数要按每个端点的分词器来算，而我们要的只是一个「离上限还有多远」的量级判断。
 */
function roughTokens(text: string): number {
	let wide = 0;
	let narrow = 0;
	for (const char of text) {
		if (eastAsianWidth(char.codePointAt(0) ?? 0) === 2) wide += 1;
		else narrow += 1;
	}
	return wide + Math.ceil(narrow / 4);
}
