import type { Config } from "../config/config-file.ts";
import { computeCost, type ModelEntry, type ProviderEntry } from "../config/providers-file.ts";
import type { LlmClient } from "../llm/client.ts";
import { clampEffort } from "../llm/effort.ts";
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
}

export interface SubagentContext {
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly signal: AbortSignal;
	/** 阶段性进度，交给界面显示。子代理的对话本身不进主对话 */
	readonly onProgress: (text: string) => void;
}

/** done 是它自己说完了；其余三种都意味着这件事没有做完，汇报里必须说清楚。 */
export type SubagentStopReason = "done" | "steps" | "error" | "aborted";

export interface SubagentOutcome {
	readonly report: string;
	readonly steps: number;
	readonly stopReason: SubagentStopReason;
}

export class Subagent {
	readonly #deps: SubagentDeps;

	constructor(deps: SubagentDeps) {
		this.#deps = deps;
	}

	async run(task: string, context: SubagentContext): Promise<SubagentOutcome> {
		const declarations = this.#deps.tools.list();
		const system = buildSubagentPrompt({ cwd: context.workspace.root, tools: declarations });
		const messages: LlmMessage[] = [{ role: "user", content: task }];
		/** 最后一次说出口的话。用满步数时它是汇报里唯一有价值的部分 */
		let said = "";

		for (let step = 1; step <= this.#deps.maxSteps; step += 1) {
			if (context.signal.aborted) {
				return { report: abortedReport(step - 1), steps: step - 1, stopReason: "aborted" };
			}
			context.onProgress(`step ${step}/${this.#deps.maxSteps}`);

			const result = await this.#deps.client
				.stream({
					model: this.#deps.model.id,
					system,
					messages,
					tools: declarations.map((tool) => ({
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
					signal: context.signal,
				})
				.result();

			if (result.usage !== undefined) {
				await this.#deps.session.append({
					type: "usage",
					provider: this.#deps.provider.id,
					model: this.#deps.model.id,
					kind: "subagent",
					usage: result.usage,
					cost: computeCost(this.#deps.model.cost, result.usage),
				});
			}

			if (result.stopReason === "aborted") {
				return { report: abortedReport(step), steps: step, stopReason: "aborted" };
			}
			if (result.stopReason === "error") {
				return {
					report: `The subagent failed and did not finish: ${result.errorMessage ?? "unknown error"}`,
					steps: step,
					stopReason: "error",
				};
			}

			const assistant: LlmAssistantMessage = { role: "assistant", content: result.content };
			messages.push(assistant);
			const text = assistantText(assistant).trim();
			if (text.length > 0) said = text;

			const calls = assistantToolCalls(assistant);
			if (calls.length === 0) {
				// 不再要工具就是要交活了。一句话都没说时不能当成做完了
				return {
					report: text.length > 0 ? text : "The subagent produced no report.",
					steps: step,
					stopReason: "done",
				};
			}

			if (result.stopReason === "length") {
				// 与主对话同一条判断：被截断的参数可能指向完全不同的东西，不能拿去执行
				for (const call of calls) {
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: TRUNCATED_ARGUMENTS,
						isError: true,
					});
				}
				continue;
			}

			context.onProgress(`  calling ${calls.map((call) => call.name).join(", ")}`);
			for (const outcome of await Promise.all(calls.map((call) => this.#callTool(call, context)))) {
				messages.push(outcome);
			}
		}

		const note = `The subagent used up its ${this.#deps.maxSteps}-step budget without finishing.`;
		return {
			report: said.length > 0 ? `${note}\nIts last words were:\n${said}` : note,
			steps: this.#deps.maxSteps,
			stopReason: "steps",
		};
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

const TRUNCATED_ARGUMENTS =
	"The previous response was cut off by the output limit, so its tool arguments may be incomplete;" +
	" this call was not executed. Split the task into smaller steps.";

function abortedReport(steps: number): string {
	return `The subagent was cancelled before finishing (${steps} steps taken).`;
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
				details: { steps: outcome.steps, stopReason: outcome.stopReason },
			};
		},
	};
	return tool;
}
