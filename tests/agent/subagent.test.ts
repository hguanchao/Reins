import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSubagentTool, Subagent, type SubagentContext, type SubagentDeps } from "../../src/agent/subagent.ts";
import { EventStream } from "../../src/llm/event-stream.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../../src/llm/client.ts";
import type { LlmContentBlock, LlmToolCallBlock, LlmUsage } from "../../src/llm/messages.ts";

const SIGNAL = new AbortController().signal;
const STOP_USAGE: LlmUsage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 };

function text(content: string): readonly LlmContentBlock[] {
	return [{ type: "text", text: content }];
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmToolCallBlock {
	return { type: "toolCall", id, name, arguments: args };
}

function clientOf(turns: readonly { content: readonly LlmContentBlock[]; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; usage?: LlmUsage; errorMessage?: string }[]): LlmClient {
	const queue = [...turns];
	return {
		api: "fake",
		stream(request: LlmRequest): LlmStream {
			void request;
			const turn = queue.shift()!;
			const stream = EventStream.incremental<LlmEvent, LlmResult>();
			stream.close({
				stopReason: turn.stopReason ?? (turn.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
				content: turn.content,
				usage: turn.usage,
				errorMessage: turn.errorMessage,
				model: "m1",
			});
			return stream;
		},
	};
}

interface DepsOptions {
	readonly turns: readonly { content: readonly LlmContentBlock[]; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; usage?: LlmUsage; errorMessage?: string }[];
	readonly execute?: (call: { name: string; callId: string; args: Record<string, unknown> }) => { content: string; isError: boolean };
	readonly maxSteps?: number;
	readonly contextWindow?: number;
}

function makeDeps(options: DepsOptions): { deps: SubagentDeps; usageEntries: unknown[]; toolCalls: string[] } {
	const usageEntries: unknown[] = [];
	const toolCalls: string[] = [];
	const tools = {
		list: () => [{ name: "find", description: "", parameters: { type: "object", properties: {} } } as never],
		call: async (request: { name: string; callId: string; args: Record<string, unknown> }) => {
			toolCalls.push(request.name);
			const result = options.execute?.(request) ?? { content: "tool-ok", isError: false };
			return result;
		},
	} as never;
	const session = {
		id: "sess",
		path: null as string | null,
		append: async (entry: unknown) => {
			usageEntries.push(entry);
		},
	};
	const deps: SubagentDeps = {
		provider: { id: "p", name: "p", baseUrl: "b", api: undefined, apiKey: undefined, headers: {}, promptCacheKey: false, models: [] },
		model: { id: "m1", name: "m1", api: "a", baseUrl: "b", reasoning: false, thinkingLevelMap: {}, input: ["text"], cost: undefined, contextWindow: undefined, maxTokens: undefined, maxTokensField: "max_tokens", headers: {} },
		config: { provider: "p", model: "m1", reasoningEffort: "off", maxTurns: undefined } as never,
		client: clientOf(options.turns),
		tools,
		session: session as never,
		maxSteps: options.maxSteps ?? 3,
		contextWindow: options.contextWindow,
	};
	return { deps, usageEntries, toolCalls };
}

function contextOf() {
	const progress: string[] = [];
	const context: SubagentContext = {
		workspace: { root: "E:\\w" } as never,
		sandbox: {} as never,
		signal: SIGNAL,
		onProgress: (text) => progress.push(text),
	};
	return { context, progress };
}

describe("子代理", () => {
	it("一次说话就收工:文本就是汇报", async () => {
		const { deps } = makeDeps({ turns: [{ content: text("here is my report") }] });
		const outcome = await new Subagent(deps).run("task", contextOf().context);
		assert.deepEqual(outcome, { report: "here is my report", steps: 1, stopReason: "done" });
	});

	it("调工具再收工:结果按调用给回", async () => {
		const { deps, toolCalls } = makeDeps({
			turns: [{ content: [toolCall("c1", "find", { q: "x" })] }, { content: text("done") }],
			execute: (call) => ({ content: `result:${call.name}`, isError: false }),
		});
		const outcome = await new Subagent(deps).run("t", contextOf().context);
		assert.deepEqual(outcome, { report: "done", steps: 2, stopReason: "done" });
		assert.deepEqual(toolCalls, ["find"]);
	});

	it("用满步数:汇报里带最后一次说的话与步数说明", async () => {
		const { deps, toolCalls } = makeDeps({
			turns: [0, 1, 2].map(() => ({ content: [toolCall("c", "find", {})] })),
			maxSteps: 3,
		});
		const outcome = await new Subagent(deps).run("t", contextOf().context);
		assert.equal(outcome.stopReason, "steps");
		assert.equal(outcome.steps, 3);
		assert.match(outcome.report, /3-step budget/);
		assert.equal(toolCalls.length, 3);
	});

	it("用满步数且一个字没说:汇报只有说明", async () => {
		// 每一步都只要工具,从不开口:走到预算用尽,说出口的话还是空
		const { deps } = makeDeps({ turns: [0, 1].map(() => ({ content: [toolCall("c", "find", {})] })), maxSteps: 2 });
		const outcome = await new Subagent(deps).run("t", contextOf().context);
		assert.equal(outcome.stopReason, "steps");
		assert.match(outcome.report, /used up its 2-step budget/);
		assert.ok(!outcome.report.includes("Its last words"));
	});

	it("错误与中止停止运行", async () => {
		const errored = makeDeps({ turns: [{ content: [], stopReason: "error", errorMessage: "bad" }] });
		const errorOutcome = await new Subagent(errored.deps).run("t", contextOf().context);
		assert.deepEqual(errorOutcome.stopReason, "error");
		assert.match(errorOutcome.report, /The subagent failed and did not finish: bad/);

		const aborted = makeDeps({ turns: [{ content: [], stopReason: "aborted" }] });
		const abortOutcome = await new Subagent(aborted.deps).run("t", contextOf().context);
		assert.deepEqual(abortOutcome.stopReason, "aborted");
	});

	it("上下文超过预算时提前收尾,不发下一请求", async () => {
		const { deps } = makeDeps({ turns: [], contextWindow: 1 });
		const outcome = await new Subagent(deps).run("a task long enough to exceed one token", contextOf().context);
		assert.equal(outcome.stopReason, "context");
		assert.equal(outcome.steps, 0);
		assert.match(outcome.report, /context reached/);
	});

	it("每步都上报进度", async () => {
		const { deps } = makeDeps({ turns: [{ content: text("final") }] });
		const { context, progress } = contextOf();
		await new Subagent(deps).run("t", context);
		assert.ok(progress.some((line) => line.includes("step 1/3")));
	});

	it("用量按 kind=subagent 记入会话", async () => {
		const { deps, usageEntries } = makeDeps({ turns: [{ content: text("r"), usage: STOP_USAGE }] });
		await new Subagent(deps).run("t", contextOf().context);
		assert.equal(usageEntries.length, 1);
		assert.deepEqual((usageEntries[0] as { kind: string }).kind, "subagent");
	});

	it("参数不是合法 JSON 时不执行工具", async () => {
		const { deps, toolCalls } = makeDeps({
			turns: [{ content: [{ type: "toolCall", id: "c", name: "find", arguments: {}, argumentsError: "bad args" }] }, { content: text("moved on") }],
		});
		const outcome = await new Subagent(deps).run("t", contextOf().context);
		assert.deepEqual(toolCalls, []);
		assert.equal(outcome.stopReason, "done");
	});

	it("length 截断:参数不执行,回注说明后继续", async () => {
		const { deps, toolCalls } = makeDeps({
			turns: [
				{ content: [toolCall("c1", "find", {})], stopReason: "length" },
				{ content: text("wrapped") },
			],
		});
		const outcome = await new Subagent(deps).run("t", contextOf().context);
		assert.deepEqual(toolCalls, []);
		assert.deepEqual(outcome, { report: "wrapped", steps: 2, stopReason: "done" });
	});
});

describe("子代理工具包装", () => {
	it("名字与参数形状", () => {
		const { deps } = makeDeps({ turns: [] });
		const tool = createSubagentTool(deps);
		assert.equal(tool.name, "subagent");
		assert.deepEqual(tool.annotations, { readOnly: false, destructive: true, openWorld: true });
	});

	it("执行时把任务转给子代理,没做完报失败", async () => {
		const { deps } = makeDeps({ turns: [{ content: [], stopReason: "error", errorMessage: "x" }] });
		const tool = createSubagentTool(deps);
		const result = await tool.execute({
			callId: "call",
			args: { task: "do it" },
			signal: SIGNAL,
			onUpdate: () => undefined,
			workspace: { root: "E:\\w" } as never,
			sandbox: {} as never,
			session: {} as never,
		});
		assert.equal(result.isError, true);
		assert.match(result.content, /did not finish|cancelled/);
	});

	it("正常完成时把汇报原样交给主对话", async () => {
		const { deps } = makeDeps({ turns: [{ content: text("all done") }] });
		const tool = createSubagentTool(deps);
		const result = await tool.execute({
			callId: "call",
			args: { task: "do it" },
			signal: SIGNAL,
			onUpdate: () => undefined,
			workspace: { root: "E:\\w" } as never,
			sandbox: {} as never,
			session: {} as never,
		});
		assert.equal(result.isError, false);
		assert.equal(result.content, "all done");
	});
});
