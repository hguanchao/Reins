import { requestOptions, requestTools } from "./request.ts";
import { rejectToolCalls, runToolCalls, type ToolRunDeps } from "./tool-run.ts";
import type { Config } from "../config/file.ts";
import { computeCost, type ModelEntry, type ProviderEntry } from "../config/providers-file.ts";
import type { LlmClient, LlmResult } from "../llm/client.ts";
import {
	assistantToolCalls,
	type LlmAssistantMessage,
	type LlmTextBlock,
	type LlmThinkingBlock,
	type LlmUserContentBlock,
} from "../llm/messages.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionPort } from "../session/port.ts";
import { contextTokens } from "../session/usage.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import { estimateTokens, type Compactor } from "./compactor.ts";
import type { AgentEvent, AgentEventListener, AbortCause } from "./events.ts";
import type { PromptInstruction } from "./instructions.ts";
import { buildPromptSections, renderSystemPrompt, toSessionTools, type PromptSkill } from "./prompt.ts";

/** 工具结果摘要的首行上限；完整结果另存，摘要只用于界面一行显示。 */
const SUMMARY_LIMIT = 200;

/** AbortSignal 的 reason 只有调用方明确标记过才有意义，认不出来的一律当作未知。 */
function abortCauseOf(reason: unknown): AbortCause | undefined {
	return reason === "user" || reason === "session" ? reason : undefined;
}

/**
 * 写进会话的截断原因。
 *
 * 与界面上那句话分开写：这条是给模型看的上下文，措辞要稳定、不含人称；界面那句是给人看
 * 的，可以直说「你停的」。两者都由同一个原因枚举决定，不会互相矛盾。
 */
function cutOffReason(cause: AbortCause | undefined): string {
	if (cause === "user") return "the user stopped the response";
	if (cause === "session") return "the session closed";
	return "the response stopped";
}

/**
 * 回合驱动。
 *
 * 一次运行由若干回合组成：每个回合向模型发一次请求，执行它要求的工具，把结果写回会话，
 * 然后判断要不要再来一回合。回合之间没有隐藏状态——下一次请求要用的历史、提示词与工具
 * 声明全部来自会话记录，所以「重放会话能得到同样的请求」这件事是成立的。
 *
 * 每轮回报的用量记进会话（它不进上下文，只用于统计），上下文接近上限时先压缩再发请求。
 */

interface DriverDeps {
	readonly provider: ProviderEntry;
	readonly model: ModelEntry;
	readonly config: Config;
	readonly client: LlmClient;
	readonly tools: ToolRegistry;
	readonly session: SessionPort;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly onEvent: AgentEventListener;
	/** 可用技能；每轮重新取，改完 SKILL.md 下一轮就生效 */
	readonly skills?: () => readonly PromptSkill[];
	/** 用户级与项目级规则；每轮重新读，改完 AGENTS.md 下一轮就生效 */
	readonly instructions?: () => readonly PromptInstruction[];
	/** Plan 模式：提示词换成只读规划版本；工具清单由装配处收窄 */
	readonly planMode?: boolean;
	/** 撤销后的一次性提醒；装配处保证只在下一轮取一次 */
	readonly undoNotice?: () => string | undefined;
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
			// 监听者在收尾事件里抛错时不能顶替循环里抛出的原始异常
			await this.emit({ type: "run_end" }).catch(() => {});
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

		// 监听者抛错时要能中止这次请求：给它一个自己的中止器，与调用方的 signal 串联。
		const stop = new AbortController();
		const onOuterAbort = (): void => stop.abort();
		// 已经中止的 signal 不会再触发监听器。不先看一眼，这一次请求会照常发出去——
		// 使用者按了中断，却仍然花掉一次完整的模型调用。
		if (signal.aborted) stop.abort();
		else signal.addEventListener("abort", onOuterAbort, { once: true });
		const stream = this.#deps.client.stream(this.#buildRequest(stop.signal));
		try {
			for await (const event of stream) {
				if (event.type === "text_delta") await this.emit({ type: "text_delta", text: event.text });
				else if (event.type === "reasoning_delta") {
					await this.emit({ type: "reasoning_delta", text: event.text });
				} else if (event.type === "tool_call_start") {
					// 参数还在流里，工具没开始跑；界面据此把「响应」与「调用工具」分开
					await this.emit({ type: "writing_tool_call", name: event.name });
				}
			}
		} catch (error) {
			// 监听者抛错时请求还在后台消费响应体：不中止就会一直读到结束，事件全堆在缓冲区里，
			// 这一轮的助手消息也写不进会话。
			stop.abort();
			throw error;
		} finally {
			signal.removeEventListener("abort", onOuterAbort);
		}

		const result = await stream.result();
		await this.emit({ type: "turn_end", stopReason: result.stopReason });

		// 规模与用量都以提供方回报为准：这是唯一能反映真实上下文大小的数字。
		// 但只信非零值：有的网关回 {input:0, output:0} 或只给 output，把 0 当成实测值会让
		// 压缩阈值永远算不过，自动压缩从此不再触发。
		if (result.usage !== undefined) {
			const total = contextTokens(result.usage);
			if (total > 0) this.#contextTokens = total;
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
			const cause = abortCauseOf(signal.reason);
			await this.#recordCutOff(result, cutOffReason(cause));
			await this.emit({ type: "aborted", cause });
			return "end";
		}
		if (result.stopReason === "error") {
			// 请求失败多半就是因为上下文超限。此时若继续沿用上一次成功的规模，压缩判定会一直
			// 认为「还没超」，于是原样重发、再次被拒——会话卡死在同一个错误上。清掉实测值，
			// 下一轮退回按消息估算，压缩才有机会触发。
			this.#contextTokens = undefined;
			await this.#recordCutOff(result, result.errorMessage ?? "unknown error");
			await this.emit({ type: "error", message: result.errorMessage ?? "unknown error" });
			return "end";
		}

		const assistant: LlmAssistantMessage = { role: "assistant", content: result.content };
		await this.#deps.session.append({ type: "message", message: assistant });

		const calls = assistantToolCalls(assistant);
		if (calls.length === 0) {
			// 没有工具调用时被长度截断：正文只写了一半。不告诉使用者，半截回答看起来和
			// 完整回答一模一样。
			if (result.stopReason === "length") {
				await this.emit({
					type: "notice",
					message: "The response hit the output limit and was cut off; the last message is incomplete.",
				});
			}
			return "end";
		}

		if (result.stopReason === "length") {
			// 输出被长度上限截断时，流式的参数可能只是前半截。拿去做执行是危险的：
			// 一个被截断的路径或命令可能指向完全不同的东西。
			await rejectToolCalls(calls, this.#toolRunDeps(signal));
			return "continue";
		}

		await runToolCalls(calls, this.#toolRunDeps(signal));
		return "continue";
	}

	/**
	 * 主对话的工具编排参数。
	 *
	 * 与子代理共用同一份编排流程，差别只在这里的两个动作：结果写进会话、每个阶段都发事件。
	 */
	#toolRunDeps(signal: AbortSignal): ToolRunDeps {
		const deps = this.#deps;
		return {
			tools: deps.tools,
			run: {
				workspace: deps.workspace,
				sandbox: deps.sandbox,
				session: { id: deps.session.id, path: deps.session.path },
				signal,
			},
			summaryLimit: SUMMARY_LIMIT,
			write: async (outcome) => {
				await deps.session.append({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: outcome.callId,
						toolName: outcome.toolName,
						content: outcome.content,
						isError: outcome.isError,
					},
				});
			},
			onUpdate: (call, text) => {
				// 结果已写回会话，界面上的阶段性输出只是过程展示
				void this.emit({ type: "tool_update", callId: call.id, text }).catch(() => {});
			},
			reporting: {
				start: async (call) => {
					await this.emit({
						type: "tool_start",
						callId: call.id,
						name: call.name,
						args: call.arguments,
					});
				},
				end: async (outcome) => {
					await this.emit({
						type: "tool_end",
						callId: outcome.callId,
						name: outcome.toolName,
						isError: outcome.isError,
						durationMs: outcome.durationMs,
						summary: outcome.summary,
						content: outcome.content,
						...(outcome.details === undefined ? {} : { details: outcome.details }),
					});
				},
			},
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
		// 只摘要掉一条、而它本身就是超大的单条消息（粘贴的长文、关闭 spill 后的巨型工具
		// 结果）时，压缩几乎不会缩小上下文，下一轮还会再触发、再摘一次摘要本身。
		// 这种情况如实说明，不再浪费一次摘要请求。
		if (!forced && cut === 1 && tokensBefore > 0) {
			const first = state.messages[0];
			const onlyMessage = first === undefined ? 0 : estimateTokens([first]);
			if (onlyMessage > compactor.keepBudget) {
				await this.emit({
					type: "compaction_skipped",
					message:
						"A single message is larger than the keep budget, so compacting cannot shrink the context. " +
						"Remove that message or start a new session.",
				});
				return;
			}
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

	/**
	 * 把当前的运行状态写进会话。
	 *
	 * 提示词分段、工具声明、模型与思考等级都是会话状态的一部分：记下来之后，历史重放出的
	 * 请求与当时实际发出的请求完全一致，出问题时才查得清当时用的到底是什么。
	 */
	async #syncSessionState(): Promise<void> {
		const session = this.#deps.session;
		const state = session.state();

		const undoNotice = this.#deps.undoNotice?.();
		const desiredSections = buildPromptSections({
			cwd: this.#deps.workspace.root,
			tools: this.#deps.tools.list(),
			skills: this.#deps.skills?.(),
			instructions: this.#deps.instructions?.(),
			...(this.#deps.planMode === true ? { planMode: true } : {}),
			...(undoNotice === undefined || undoNotice.length === 0 ? {} : { undoNotice }),
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
			tools: requestTools(state.tools),
			...requestOptions(this.#deps.model, this.#deps.config),
			// 同一段会话用同一个标识：端点据此把请求路由到同一片提示词缓存
			cacheKey: this.#deps.session.id,
			onRetry: (attempt, reason) => {
				// HTTP 层不等待监听者：重试提示只是给界面看的，不能拖慢退避；
				// 同样不能让监听者的异常变成无人处理的拒绝
				void this.emit({
					type: "retrying",
					attempt,
					maxAttempts: this.#deps.config.maxRetries,
					reason,
				}).catch(() => {});
			},
			signal,
		};
	}
}


