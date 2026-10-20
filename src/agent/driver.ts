import type { Config } from "../config/config-file.ts";
import { computeCost, type ModelEntry, type ProviderEntry } from "../config/providers-file.ts";
import type { LlmClient, LlmResult } from "../llm/client.ts";
import { clampEffort } from "../llm/effort.ts";
import {
	assistantToolCalls,
	type LlmAssistantMessage,
	type LlmTextBlock,
	type LlmThinkingBlock,
	type LlmToolCallBlock,
	type LlmUserContentBlock,
} from "../llm/messages.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionPort } from "../session/port.ts";
import { contextTokens } from "../session/usage.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import { estimateTokens, type Compactor } from "./compactor.ts";
import type { AgentEvent, AgentEventListener } from "./events.ts";
import { buildPromptSections, renderSystemPrompt, toSessionTools } from "./prompt.ts";

/**
 * 回合驱动。
 *
 * 一次运行由若干回合组成：每个回合向模型发一次请求，执行它要求的工具，把结果写回会话，
 * 然后判断要不要再来一回合。回合之间没有隐藏状态——下一次请求要用的历史、提示词与工具
 * 声明全部来自会话记录，所以「重放会话能得到同样的请求」这件事是成立的。
 *
 * 每轮回报的用量记进会话（它不进上下文，只用于统计），上下文接近上限时先压缩再发请求。
 */

export interface DriverDeps {
	readonly provider: ProviderEntry;
	readonly model: ModelEntry;
	readonly config: Config;
	readonly client: LlmClient;
	readonly tools: ToolRegistry;
	readonly session: SessionPort;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly onEvent: AgentEventListener;
	/** 上下文压缩。没有它（上限未知或未配置）就不压缩，请求照原样发出去 */
	readonly compactor?: Compactor;
	/** 本次运行开始时已知的上下文规模；续聊或每轮新建驱动时由装配处从会话记录里带来 */
	readonly contextTokens?: number;
}

export class TurnDriver {
	readonly #deps: DriverDeps;
	/**
	 * 上一次请求的上下文规模。
	 *
	 * 提供方回报的用量最准，但它只在一次请求之后才知道；重启或续聊后的第一次请求只能靠估算，
	 * 因此这里为空时由压缩逻辑自己估。
	 */
	#contextTokens: number | undefined;

	constructor(deps: DriverDeps) {
		this.#deps = deps;
		this.#contextTokens = deps.contextTokens;
	}

	/** 把一句话（可带图片）交给模型，一直跑到它不再要求调用工具为止。 */
	async run(prompt: string | readonly LlmUserContentBlock[], signal: AbortSignal): Promise<void> {
		await this.#syncSessionState();
		await this.#deps.session.append({
			type: "message",
			message: { role: "user", content: prompt },
		});

		try {
			for (;;) {
				await this.#compactIfNeeded(signal);
				const next = await this.#runTurn(signal);
				if (next === "end") break;
			}
		} finally {
			await this.emit({ type: "run_end" });
		}
	}

	async emit(event: AgentEvent): Promise<void> {
		await this.#deps.onEvent(event);
	}

	/**
	 * 立即压缩上下文，不看自动阈值。
	 *
	 * 使用者主动要求压缩时，不必等到接近上限；压缩多少仍按同一份保留额度来算，上下文本来就
	 * 在额度之内就没有可压的部分。压缩器缺席时也要说出来——静默不动会让人以为已经压过了。
	 */
	async compact(signal: AbortSignal): Promise<void> {
		if (this.#deps.compactor === undefined) {
			await this.emit({
				type: "compaction_failed",
				message: "No context window is declared, so the context cannot be compacted",
			});
			return;
		}
		await this.#compactIfNeeded(signal, true);
	}

	async #runTurn(signal: AbortSignal): Promise<"continue" | "end"> {
		await this.emit({ type: "turn_start" });

		const stream = this.#deps.client.stream(this.#buildRequest(signal));
		for await (const event of stream) {
			if (event.type === "text_delta") await this.emit({ type: "text_delta", text: event.text });
			else if (event.type === "reasoning_delta") {
				await this.emit({ type: "reasoning_delta", text: event.text });
			}
		}

		const result = await stream.result();
		await this.emit({ type: "turn_end", stopReason: result.stopReason });

		// 规模与用量都以提供方回报为准：这是唯一能反映真实上下文大小的数字
		if (result.usage !== undefined) {
			this.#contextTokens = contextTokens(result.usage);
			await this.#deps.session.append({
				type: "usage",
				provider: this.#deps.provider.id,
				model: this.#deps.model.id,
				kind: "turn",
				usage: result.usage,
				cost: computeCost(this.#deps.model.cost, result.usage),
			});
			await this.emit({
				type: "usage_recorded",
				kind: "turn",
				tokens: result.usage.total,
			});
		}

		if (result.stopReason === "aborted") {
			await this.#recordCutOff(result, "the user interrupted the response");
			await this.emit({ type: "aborted" });
			return "end";
		}
		if (result.stopReason === "error") {
			await this.#recordCutOff(result, result.errorMessage ?? "unknown error");
			await this.emit({ type: "error", message: result.errorMessage ?? "unknown error" });
			return "end";
		}

		const assistant: LlmAssistantMessage = { role: "assistant", content: result.content };
		await this.#deps.session.append({ type: "message", message: assistant });

		const calls = assistantToolCalls(assistant);
		if (calls.length === 0) return "end";

		if (result.stopReason === "length") {
			// 输出被长度上限截断时，流式的参数可能只是前半截。拿去做执行是危险的：
			// 一个被截断的路径或命令可能指向完全不同的东西。
			await this.#recordFailures(
				calls,
				"The previous response was cut off by the output limit, so its tool arguments may be" +
					" incomplete; this call was not executed. Split the task into smaller steps, or send" +
					" less in a single response.",
			);
			return "continue";
		}

		await this.#runTools(calls, signal);
		return "continue";
	}

	async #runTools(calls: readonly LlmToolCallBlock[], signal: AbortSignal): Promise<void> {
		const outcomes = await Promise.all(calls.map((call) => this.#runTool(call, signal)));
		// 结果按模型给出的顺序写回：并行执行改变的是完成次序，不是对话里的次序
		for (const outcome of outcomes) {
			await this.#deps.session.append({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: outcome.callId,
					toolName: outcome.toolName,
					content: outcome.content,
					isError: outcome.isError,
				},
			});
		}
	}

	async #runTool(call: LlmToolCallBlock, signal: AbortSignal): Promise<ToolOutcome> {
		if (call.argumentsError !== undefined) {
			// 参数不是合法 JSON 时不能拿空对象去执行：那等于替使用者猜了一个调用
			return { callId: call.id, toolName: call.name, content: call.argumentsError, isError: true };
		}

		await this.emit({ type: "tool_start", callId: call.id, name: call.name, args: call.arguments });
		const outcome = await this.#deps.tools.call(
			{ callId: call.id, name: call.name, args: call.arguments },
			{
				workspace: this.#deps.workspace,
				sandbox: this.#deps.sandbox,
				session: { id: this.#deps.session.id, path: this.#deps.session.path },
				signal,
				onUpdate: (text) => {
					// 阶段性输出只是给界面看的，不参与对话内容，因此不阻塞执行
					void this.emit({ type: "tool_update", callId: call.id, text });
				},
			},
		);
		await this.emit({
			type: "tool_end",
			callId: call.id,
			name: call.name,
			isError: outcome.isError,
			durationMs: outcome.durationMs,
			summary: firstLine(outcome.content),
			content: outcome.content,
			...(outcome.details === undefined ? {} : { details: outcome.details }),
		});
		return {
			callId: call.id,
			toolName: call.name,
			content: outcome.content,
			isError: outcome.isError,
		};
	}

	/**
	 * 上下文太长时先压缩再发请求。
	 *
	 * 判断与压缩都在请求之前：等到端点拒绝就已经晚了。压缩失败不改变本轮的处理——上下文照原
	 * 样发出去，但失败原因要说出来，否则使用者只会看到「莫名其妙被拒绝」。
	 *
	 * 手动触发时跳过阈值判断；压缩量仍由保留额度决定，所以上下文很短时可能没有可压的部分。
	 */
	async #compactIfNeeded(signal: AbortSignal, forced = false): Promise<void> {
		const compactor = this.#deps.compactor;
		if (compactor === undefined) return;

		const state = this.#deps.session.state();
		const tokensBefore = this.#contextTokens ?? estimateTokens(state.messages);
		if (!forced && !compactor.shouldCompact(tokensBefore)) return;

		const cut = compactor.plan(state.messages);
		if (cut === 0) {
			// 自动压缩在额度之下本来就该安静；手动压缩是使用者的明确要求，必须给个交代
			if (forced) {
				await this.emit({
					type: "compaction_skipped",
					message: "There is nothing to compact yet",
				});
			}
			return;
		}

		await this.emit({ type: "compaction_start", messages: cut, tokensBefore });
		const result = await compactor.summarize(state.messages.slice(0, cut), signal);
		if (!result.ok) {
			await this.emit({ type: "compaction_failed", message: result.message });
			return;
		}

		await this.#deps.session.append({
			type: "compaction",
			summary: result.summary,
			covered: state.messageIds.slice(0, cut),
			provider: compactor.provider,
			model: compactor.model,
			tokensBefore,
			usage: result.usage,
		});
		if (result.usage !== undefined) {
			await this.#deps.session.append({
				type: "usage",
				provider: compactor.provider,
				model: compactor.model,
				kind: "compact",
				usage: result.usage,
				cost: result.cost,
			});
			await this.emit({
				type: "usage_recorded",
				kind: "compact",
				tokens: result.usage.total,
			});
		}

		// 压缩后的规模只能靠估算：下一次请求发出去之前没有人回报它
		this.#contextTokens = undefined;
		await this.emit({
			type: "compaction_end",
			covered: cut,
			tokensBefore,
			tokensAfter: estimateTokens(this.#deps.session.state().messages),
		});
	}

	/**
	 * 把中断前已经收到的回答写进会话。
	 *
	 * 连接断了不等于那段回答没发生过——界面上早就显示过了，丢掉只会让下一轮模型以为它从没
	 * 说过。工具调用不写回去：没有对应结果的工具调用会让下一次请求直接不合法；改由末尾的
	 * 提示说明它没执行。提示同时让模型知道自己说的话被截断了，而不是就这么结束了。
	 */
	async #recordCutOff(result: LlmResult, reason: string): Promise<void> {
		const content = result.content.filter(
			(block): block is LlmTextBlock | LlmThinkingBlock =>
				block.type === "text" || block.type === "thinking",
		);
		const dropped = result.content.length - content.length;
		if (content.length === 0 && dropped === 0) return;

		const note =
			dropped === 0
				? `[the response was cut off: ${reason}]`
				: `[the response was cut off: ${reason}; ${dropped} tool request(s) in it were not executed]`;
		await this.#deps.session.append({
			type: "message",
			message: {
				role: "assistant",
				content: [...content, { type: "text", text: note }],
			},
		});
	}

	async #recordFailures(calls: readonly LlmToolCallBlock[], content: string): Promise<void> {
		for (const call of calls) {
			await this.#deps.session.append({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content,
					isError: true,
				},
			});
			// 也要告诉界面：不发声的话，使用者只看到这一轮突然停下，不知道工具根本没执行
			await this.emit({
				type: "tool_end",
				callId: call.id,
				name: call.name,
				isError: true,
				durationMs: 0,
				summary: firstLine(content),
				content,
			});
		}
	}

	/**
	 * 把当前的运行状态写进会话。
	 *
	 * 提示词分段、工具声明、模型与思考等级都是会话状态的一部分：记下来之后，历史重放出的
	 * 请求与当时实际发出的请求完全一致，出问题时才查得清当时用的到底是什么。
	 */
	async #syncSessionState(): Promise<void> {
		const session = this.#deps.session;
		const state = session.state();

		const desiredSections = buildPromptSections({
			cwd: this.#deps.workspace.root,
			tools: this.#deps.tools.list(),
		});
		const sectionChanges: Record<string, string | null> = {};
		for (const [name, body] of Object.entries(desiredSections)) {
			if (state.sections[name] !== body) sectionChanges[name] = body;
		}
		for (const name of Object.keys(state.sections)) {
			if (desiredSections[name] === undefined) sectionChanges[name] = null;
		}

		const desiredTools = toSessionTools(this.#deps.tools.list());
		const added = desiredTools.filter((tool) => !state.tools.some((item) => item.name === tool.name));
		const removed = state.tools
			.filter((tool) => !desiredTools.some((item) => item.name === tool.name))
			.map((tool) => tool.name);

		if (Object.keys(sectionChanges).length > 0 || added.length > 0 || removed.length > 0) {
			await session.append({
				type: "system",
				sections: sectionChanges,
				...(added.length === 0 ? {} : { toolsAdded: added }),
				...(removed.length === 0 ? {} : { toolsRemoved: removed }),
			});
		}

		const model = { provider: this.#deps.provider.id, model: this.#deps.model.id };
		if (state.model === undefined || state.model.provider !== model.provider || state.model.model !== model.model) {
			await session.append({ type: "model_change", provider: model.provider, model: model.model });
		}
		if (state.effort !== this.#deps.config.reasoningEffort) {
			await session.append({ type: "effort_change", effort: this.#deps.config.reasoningEffort });
		}
	}

	#buildRequest(signal: AbortSignal): Parameters<LlmClient["stream"]>[0] {
		const state = this.#deps.session.state();
		return {
			model: this.#deps.model.id,
			system: renderSystemPrompt(state.sections),
			messages: state.messages,
			tools: state.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			maxTokens: this.#deps.model.maxTokens ?? this.#deps.config.maxTokens,
			effort: clampEffort(
				this.#deps.config.reasoningEffort,
				this.#deps.model.reasoning,
				this.#deps.model.thinkingLevelMap,
			),
			// 同一段会话用同一个标识：端点据此把请求路由到同一片提示词缓存
			cacheKey: this.#deps.session.id,
			onRetry: (attempt, reason) => {
				// HTTP 层不等待监听者：重试提示只是给界面看的，不能拖慢退避
				void this.emit({ type: "retrying", attempt, reason });
			},
			signal,
		};
	}
}

/** 取首行作为摘要。整段结果可能很长，而界面上要的只是「它到底做成了没有、为什么没做成」。 */
function firstLine(content: string): string {
	const line = content.split("\n", 1)[0] ?? "";
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

interface ToolOutcome {
	readonly callId: string;
	readonly toolName: string;
	readonly content: string;
	readonly isError: boolean;
}
