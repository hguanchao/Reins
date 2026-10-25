import type { Config } from "../config/file.ts";
import { computeCost, type ModelEntry, type ProviderEntry } from "../config/providers-file.ts";
import type { LlmClient, LlmResult } from "../llm/client.ts";
import { requestOptions, requestTools, TRUNCATED_TOOL_ARGUMENTS } from "./request.ts";
import {
	assistantText,
	assistantToolCalls,
	type LlmAssistantMessage,
	type LlmMessage,
	type LlmToolCallBlock,
	type LlmToolResultMessage,
} from "../llm/messages.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionPort } from "../session/port.ts";
import type { AnyToolDefinition, ToolDefinition, ToolResult } from "../tools/contract.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { JsonSchema } from "../tools/schema.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import { estimateTokens } from "./compactor.ts";
import type { PromptInstruction } from "./instructions.ts";
import { buildSubagentPrompt } from "./prompt.ts";

/**
 * 子代理。
 *
 * 一件独立的事交给子代理之后，它有自己的上下文、自己的步数预算，主对话只拿到它最后交回的
 * 那份汇报。这样一件事做砸了不会把主对话的上下文搅乱，读了很多文件也撑不爆主对话。
 *
 * 步数上限只约束子代理。主对话由使用者盯着，随时可以叫停，它要跑多久是使用者自己的事；
 * 子代理是模型自己派出去的，没有上限时一次误判就能连着派出很多轮请求，而使用者看不到
 * 中间发生了什么，只看到账单在涨。
 *
 * 子代理与主对话共用工作区、沙箱与审批链路：它调用的每个工具都还是走注册表那一条管线，
 * 所以「派个子代理去绕开审批」这件事在结构上不成立。
 */

/** 配置里没写 max_turns 时子代理的步数上限。 */
export const DEFAULT_SUBAGENT_STEPS = 20;

/**
 * 子代理的上下文预算比例。
 *
 * 估算不含系统提示词与工具声明，且还要给这一次的输出留空间，所以低于主对话的压缩阈值。
 */
const CONTEXT_BUDGET_RATIO = 0.7;

/**
 * 一步开工前的两项检查:使用者是否已经中止、上下文是否撞到预算。
 * 都没撞上返回 undefined,循环继续。
 */
function stepBudgetCheck(
	step: number,
	messages: readonly LlmMessage[],
	context: SubagentContext,
	contextWindow: number | undefined,
): { report: string; steps: number; stopReason: SubagentStopReason } | undefined {
	if (context.signal.aborted) {
		return { report: abortedReport(step - 1), steps: step - 1, stopReason: "aborted" };
	}
	if (contextWindow === undefined) return undefined;
	if (estimateTokens(messages) < contextWindow * CONTEXT_BUDGET_RATIO) return undefined;
	return {
		report:
			`The subagent stopped before finishing: its context reached the ` +
			`${Math.round(CONTEXT_BUDGET_RATIO * 100)}% budget of ${contextWindow} tokens. ` +
			"Split the task into smaller pieces or ask for a narrower scope.",
		steps: step - 1,
		stopReason: "context",
	};
}

export interface SubagentDeps {
	readonly provider: ProviderEntry;
	readonly model: ModelEntry;
	readonly config: Config;
	readonly client: LlmClient;
	/** 子代理能用的工具。传进来的集合不含子代理工具本身，因此子代理不会再派子代理 */
	readonly tools: ToolRegistry;
	/** 用量记进哪个会话：子代理花掉的 token 与主对话是同一笔账 */
	readonly session: SessionPort;
	/** 一次运行最多向模型发几次请求 */
	readonly maxSteps: number;
	/** 子代理所用模型的上下文上限；声明后超过预算就提前收尾，不让端点拒绝 */
	readonly contextWindow?: number;
	/** 用户级与项目级规则；与主对话共用同一份来源 */
	readonly instructions?: () => readonly PromptInstruction[];
}

export interface SubagentContext {
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly signal: AbortSignal;
	/** 阶段性进度，交给界面显示。子代理的对话本身不进主对话 */
	readonly onProgress: (text: string) => void;
}

/** done 是它自己说完了；其余几种都意味着这件事没有做完，汇报里必须说清楚。 */
export type SubagentStopReason = "done" | "steps" | "context" | "error" | "aborted";

export interface SubagentOutcome {
	readonly report: string;
	readonly steps: number;
	readonly stopReason: SubagentStopReason;
	/** 本代理的总耗时（毫秒）；界面把它显示在调用行与清单行的耗时位 */
	readonly durationMs: number;
	/** 最后一步在调用的工具与参数摘要；界面在运行期间把它显示在调用行上 */
	readonly lastActivity: string | undefined;
	/** 本代理消耗的 token 总量(input+output+cache 合计);没有用量回报时为 undefined */
	readonly totalTokens: number | undefined;
}

export class Subagent {
	readonly #deps: SubagentDeps;

	constructor(deps: SubagentDeps) {
		this.#deps = deps;
	}

	async run(task: string, context: SubagentContext): Promise<SubagentOutcome> {
		const declarations = this.#deps.tools.list();
		const system = buildSubagentPrompt({
			cwd: context.workspace.root,
			tools: declarations,
			instructions: this.#deps.instructions?.(),
		});
		const messages: LlmMessage[] = [{ role: "user", content: task }];
		/** 最后一次说出口的话。用满步数时它是汇报里唯一有价值的部分 */
		let said = "";
		const startedAt = Date.now();
		/** 最后一次报给界面的活动描述(工具名+参数摘要),运行期间调用行就显示这一句 */
		let lastActivity: string | undefined;
		/** 各步用量的合计;界面在清单行与组头显示 ⇣token */
		let totalTokens: number | undefined = undefined;

		for (let step = 1; step <= this.#deps.maxSteps; step += 1) {
			const stopped = stepBudgetCheck(step, messages, context, this.#deps.contextWindow);
			if (stopped !== undefined) return this.#finish(stopped, startedAt, lastActivity, totalTokens);
			context.onProgress(`step ${step}/${this.#deps.maxSteps}`);

			const stepResult = await this.#requestStep(system, messages, step, context);
			if ("stopReason" in stepResult && "report" in stepResult) {
				return this.#finish(stepResult, startedAt, lastActivity, totalTokens);
			}
			const result: LlmResult = stepResult;

			if (result.usage !== undefined) {
				totalTokens = (totalTokens ?? 0) + result.usage.total;
				await this.#deps.session.append({
					type: "usage",
					provider: this.#deps.provider.id,
					model: this.#deps.model.id,
					kind: "subagent",
					usage: result.usage,
					cost: computeCost(this.#deps.model.cost, result.usage),
				});
			}

			const assistant: LlmAssistantMessage = { role: "assistant", content: result.content };
			messages.push(assistant);
			const text = assistantText(assistant).trim();
			if (text.length > 0) said = text;

			const calls = assistantToolCalls(assistant);
			if (calls.length === 0) {
				// 不再要工具就是要交活了。一句话都没说时不能当成做完了
				return this.#finish(
					{
						report: text.length > 0 ? text : "The subagent produced no report.",
						steps: step,
						stopReason: "done",
					},
					startedAt,
					lastActivity,
					totalTokens,
				);
			}

			if (result.stopReason === "length") {
				// 与主对话同一条判断：被截断的参数可能指向完全不同的东西，不能拿去执行
				for (const call of calls) {
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: TRUNCATED_TOOL_ARGUMENTS,
						isError: true,
					});
				}
				continue;
			}

			// 界面只看得到当前这一步:工具名+首个参数摘要,一句话说完它在干什么
			const focus = calls[0];
			lastActivity =
				focus === undefined
					? undefined
					: `${focus.name}  ${firstArgumentSummary(focus.arguments)}`;
			context.onProgress(lastActivity ?? `step ${step}/${this.#deps.maxSteps}`);
			for (const outcome of await Promise.all(calls.map((call) => this.#callTool(call, context)))) {
				messages.push(outcome);
			}
		}

		return this.#finish(
			{
				report: saidSuffix(said, this.#deps.maxSteps),
				steps: this.#deps.maxSteps,
				stopReason: "steps",
			},
			startedAt,
			lastActivity,
			totalTokens,
		);
	}

	/** 结局补上耗时与最后活动与用量合计:所有 return 都经这里,字段口径只有这一份。 */
	#finish(
		outcome: { report: string; steps: number; stopReason: SubagentStopReason },
		startedAt: number,
		lastActivity: string | undefined,
		totalTokens: number | undefined,
	): SubagentOutcome {
		return {
			...outcome,
			durationMs: Math.max(0, Date.now() - startedAt),
			lastActivity,
			totalTokens,
		};
	}

	/** 一步请求:发出去、消费增量、把请求层的中止与失败换算成结局(不含耗时,由 #finish 补)。 */
	async #requestStep(
		system: string,
		messages: LlmMessage[],
		steps: number,
		context: SubagentContext,
	): Promise<LlmResult | { report: string; steps: number; stopReason: SubagentStopReason }> {
		const stream = this.#deps.client.stream({
			model: this.#deps.model.id,
			system,
			messages,
			tools: requestTools(this.#deps.tools.list()),
			...requestOptions(this.#deps.model, this.#deps.config),
			onRetry: (attempt, reason) => context.onProgress(`retrying (${attempt}): ${reason}`),
			signal: context.signal,
		});
		// 子代理只看最终结论，但增量仍要消费掉：流不迭代会把整轮输出无限堆在缓冲里
		for await (const event of stream) {
			void event;
		}
		const result = await stream.result();

		if (result.stopReason === "aborted") {
			return { report: abortedReport(steps), steps, stopReason: "aborted" };
		}
		if (result.stopReason === "error") {
			return {
				report: `The subagent failed and did not finish: ${result.errorMessage ?? "unknown error"}`,
				steps,
				stopReason: "error",
			};
		}
		return result;
	}

	async #callTool(call: LlmToolCallBlock, context: SubagentContext): Promise<LlmToolResultMessage> {
		if (call.argumentsError !== undefined) {
			// 参数不是合法 JSON 时不能拿空对象去执行：那等于替使用者猜了一个调用
			return {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: call.argumentsError,
				isError: true,
			};
		}

		const result = await this.#deps.tools.call(
			{ callId: call.id, name: call.name, args: call.arguments },
			{
				workspace: context.workspace,
				sandbox: context.sandbox,
				session: { id: this.#deps.session.id, path: this.#deps.session.path },
				signal: context.signal,
				onUpdate: context.onProgress,
			},
		);
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			isError: result.isError,
		};
	}
}

function abortedReport(steps: number): string {
	return `The subagent was cancelled before finishing (${steps} steps taken).`;
}

/** 用满步数时的汇报:预算说清楚,它最后说过的话是唯一有价值的线索。 */
function saidSuffix(said: string, maxSteps: number): string {
	const note = `The subagent used up its ${maxSteps}-step budget without finishing.`;
	return said.length > 0 ? `${note}\nIts last words were:\n${said}` : note;
}

/** 首个参数的短摘要,给运行期的活动行看;没有可读参数时只给工具名。 */
function firstArgumentSummary(args: Record<string, unknown>): string {
	const first = Object.values(args).find((value) => typeof value === "string" && value.length > 0);
	if (typeof first !== "string") return "";
	const line = first.split("\n", 1)[0] ?? "";
	return line.length > 30 ? `${line.slice(0, 29)}…` : line;
}

const PARAMETERS = {
	type: "object",
	properties: {
		task: {
			type: "string",
			description:
				"The task to hand to the subagent. State the goal, the files involved, and what counts as done; the subagent cannot see this conversation, only this description.",
		},
	},
	required: ["task"],
} as const satisfies JsonSchema;

/** 写成类型别名而不是接口：接口没有隐式索引签名，放不进注册表保存工具用的那个类型。 */
type SubagentArgs = {
	readonly task: string;
};

/** 把子代理包成一个工具，交给模型调用。 */
export function createSubagentTool(deps: SubagentDeps): AnyToolDefinition {
	const subagent = new Subagent(deps);
	const tool: ToolDefinition<SubagentArgs> = {
		name: "subagent",
		summary: "Delegate one self-contained task to a subagent with its own context",
		description:
			`Hand one self-contained piece of work to a subagent with its own context and a budget of ${deps.maxSteps} steps; it reports back when done.` +
			" Good for work that reads many files and runs many commands but ends in a few lines of conclusions." +
			" The subagent cannot see this conversation, so describe the task fully; it runs in the same workspace" +
			" under the same approval and sandbox rules, and its edits land on real files.",
		parameters: PARAMETERS,
		// 它自己能改文件也能跑命令，因此照实声明：派出去的子代理干的活，后果与直接调用一样
		annotations: { readOnly: false, destructive: true, openWorld: true },

		async execute(context): Promise<ToolResult> {
			const outcome = await subagent.run(context.args.task, {
				workspace: context.workspace,
				sandbox: context.sandbox,
				signal: context.signal,
				onProgress: context.onUpdate,
			});
			return {
				content: outcome.report,
				// 没做完就算失败：报成成功会让模型以为这件事已经了结
				isError: outcome.stopReason !== "done",
				// 界面靠这份状态渲染调用行与清单行;只给界面,不发给模型
				details: {
					steps: outcome.steps,
					stopReason: outcome.stopReason,
					durationMs: outcome.durationMs,
					lastActivity: outcome.lastActivity,
					totalTokens: outcome.totalTokens,
				},
			};
		},
	};
	return tool;
}
