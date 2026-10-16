import type { Config } from "../config/config-file.ts";
import type { ModelEntry, ProviderEntry } from "../config/models-file.ts";
import type { LlmClient } from "../llm/client.ts";
import { clampEffort } from "../llm/effort.ts";
import {
	assistantToolCalls,
	type LlmAssistantMessage,
	type LlmToolCallBlock,
} from "../llm/messages.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionPort } from "../session/port.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import type { AgentEvent, AgentEventListener } from "./events.ts";
import { buildPromptSections, renderSystemPrompt, toSessionTools } from "./prompt.ts";

/**
 * 回合驱动。
 *
 * 一次运行由若干回合组成：每个回合向模型发一次请求，执行它要求的工具，把结果写回会话，
 * 然后判断要不要再来一回合。回合之间没有隐藏状态——下一次请求要用的历史、提示词与工具
 * 声明全部来自会话记录，所以「重放会话能得到同样的请求」这件事是成立的。
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
}

export class TurnDriver {
	readonly #deps: DriverDeps;

	constructor(deps: DriverDeps) {
		this.#deps = deps;
	}

	/** 把一句话交给模型，一直跑到它不再要求调用工具为止。 */
	async run(prompt: string, signal: AbortSignal): Promise<void> {
		await this.#syncSessionState();
		await this.#deps.session.append({
			type: "message",
			message: { role: "user", content: prompt },
		});

		try {
			for (;;) {
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

		if (result.stopReason === "aborted") {
			await this.emit({ type: "aborted" });
			return "end";
		}
		if (result.stopReason === "error") {
			await this.emit({ type: "error", message: result.errorMessage ?? "未知错误" });
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
				"上一轮输出被长度上限截断，工具参数可能不完整，因此这次没有执行。" +
					"请把任务拆小一些，或减少一次输出的内容量。",
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
		});
		return {
			callId: call.id,
			toolName: call.name,
			content: outcome.content,
			isError: outcome.isError,
		};
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
