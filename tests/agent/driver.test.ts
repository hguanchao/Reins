import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TurnDriver } from "#src/agent/driver.ts";
import { EventStream } from "#src/llm/event-stream.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "#src/llm/client.ts";
import type { LlmContentBlock, LlmMessage, LlmToolCallBlock, LlmUsage } from "#src/llm/messages.ts";
import type { AgentEvent } from "#src/agent/events.ts";
import type { CompactionResult, Compactor } from "#src/agent/compactor.ts";
import type { PromptInstruction } from "#src/agent/instructions.ts";
import type { SessionEntry, SessionState, SessionToolDeclaration } from "#src/session/port.ts";

const STOP: LlmUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
const SIGNAL = new AbortController().signal;

interface ScriptedTurn {
	readonly content: readonly LlmContentBlock[];
	readonly stopReason?: LlmResult["stopReason"];
	readonly usage?: LlmUsage;
	readonly errorMessage?: string;
}

function scriptedStream(turn: ScriptedTurn): LlmStream {
	const stream = EventStream.incremental<LlmEvent, LlmResult>();
	stream.push({ type: "text_delta", text: "chunk" });
	for (const [index, block] of turn.content.entries()) {
		if (block.type === "toolCall") {
			stream.push({ type: "tool_call_start", index, id: block.id, name: block.name });
		}
	}
	const stopReason =
		turn.stopReason ?? (turn.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
	stream.close({
		stopReason,
		content: turn.content,
		usage: turn.usage,
		errorMessage: turn.errorMessage,
		model: "m1",
	});
	return stream;
}

/** 内存会话:条目直接存,折叠交给宿主的 SessionFolder 等价物——这里手工维护一份。 */
class MemorySession {
	readonly id = "mem";
	readonly path: string | null = null;
	readonly entries: SessionEntry[] = [];
	#sections: Record<string, string> = {};
	#tools: SessionToolDeclaration[] = [];
	#messages: LlmMessage[] = [];
	#messageIds: string[] = [];
	#model: { provider: string; model: string } | undefined = undefined;
	#effort: string | undefined = undefined;

	state(): SessionState {
		return {
			sections: { ...this.#sections },
			tools: [...this.#tools],
			messages: [...this.#messages],
			messageIds: [...this.#messageIds],
			model: this.#model,
			effort: this.#effort,
		};
	}

	async append(entry: SessionEntry): Promise<void> {
		this.entries.push(entry);
		switch (entry.type) {
			case "message":
				if (entry.message.role !== "toolResult") {
					this.#messages.push(entry.message);
					this.#messageIds.push(entry.id);
				}
				return;
			case "system":
				for (const [name, body] of Object.entries(entry.sections)) {
					if (body === null) delete this.#sections[name];
					else this.#sections[name] = body;
				}
				this.#tools = [
					...this.#tools.filter((tool) => !(entry.toolsRemoved ?? []).includes(tool.name)),
					...(entry.toolsAdded ?? []),
				];
				return;
			case "model_change":
				this.#model = { provider: entry.provider, model: entry.model };
				return;
			case "effort_change":
				this.#effort = entry.effort;
				return;
			case "compaction":
				this.#messages = [
					{ role: "user", content: `(Summary of the earlier conversation, kept so the work can continue)\n\n${entry.summary}` },
					...this.#messages.filter((_message, index) => !entry.covered.includes(this.#messageIds[index])),
				];
				this.#messageIds = [entry.id, ...this.#messageIds.filter((id) => !entry.covered.includes(id))];
				return;
			case "usage":
				return;
		}
	}
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmToolCallBlock {
	return { type: "toolCall", id, name, arguments: args };
}

const TOOL = {
	name: "echo",
	description: "echoes",
	parameters: { type: "object" as const, properties: {} },
	annotations: { readOnly: true, destructive: false, openWorld: false },
	execute: async () => ({ content: "tool-outcome", isError: false }),
};

function makeTools(executed: { calls: string[] } = { calls: [] }) {
	return {
		list: () => [TOOL],
		call: async (request: { name: string; callId: string; args: Record<string, unknown> }) => {
			executed.calls.push(`${request.name}:${JSON.stringify(request.args)}`);
			return { content: "tool-outcome", isError: false, durationMs: 1 };
		},
	};
}

function depsOf(turns: readonly ScriptedTurn[], hooks: { events: AgentEvent[]; session: MemorySession; tools: ReturnType<typeof makeTools>; compactor?: Compactor; contextTokens?: number; requests?: LlmRequest[]; onRequest?: (request: LlmRequest) => void; instructions?: () => readonly PromptInstruction[]; planMode?: boolean; undoNotice?: () => string | undefined }): TurnDriver {
	const queue = [...turns];
	const client: LlmClient = {
		api: "fake",
		stream: (request: LlmRequest) => {
			hooks.requests?.push(request);
			hooks.onRequest?.(request);
			const turn = queue.shift() ?? { content: [] };
			return scriptedStream(turn);
		},
	};
	return new TurnDriver({
		provider: { id: "p", name: "p", baseUrl: "b", api: undefined, apiKey: undefined, headers: {}, promptCacheKey: false, models: [] },
		model: {
			id: "m1",
			name: "m1",
			api: "a",
			baseUrl: "b",
			reasoning: false,
			thinkingLevelMap: {},
			input: ["text"],
			cost: undefined,
			contextWindow: 10,
			maxTokens: undefined,
			maxTokensField: "max_tokens",
			headers: {},
		},
		config: {
			provider: "p",
			model: "m1",
			reasoningEffort: "off",
			sandbox: "off",
			approval: "ask",
			maxRetries: 1,
			spillThreshold: 0,
			ui: { notify: "auto" },
			mcpServers: [],
			plugins: { disabled: [], trusted: [] },
		} as never,
		client,
		tools: hooks.tools as never,
		session: hooks.session as never,
		workspace: { root: "E:\\w" } as never,
		sandbox: {} as never,
		compactor: hooks.compactor,
		...(hooks.contextTokens === undefined ? {} : { contextTokens: hooks.contextTokens }),
		...(hooks.instructions === undefined ? {} : { instructions: hooks.instructions }),
		...(hooks.planMode === true ? { planMode: true } : {}),
		...(hooks.undoNotice === undefined ? {} : { undoNotice: hooks.undoNotice }),
		onEvent: async (event) => {
			hooks.events.push(event);
		},
	});
}

describe("回合驱动", () => {
	it("纯文本回合:一次请求即结束,用量落盘", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		await depsOf([{ content: [{ type: "text", text: "hi" }], usage: STOP }], hooks).run("hello", SIGNAL);

		const types = hooks.session.entries.map((entry) => entry.type);
		assert.ok(types.includes("message") && types.includes("usage"));
		assert.ok(hooks.events.some((event) => event.type === "run_end"));
		// 用量落盘后要立刻告诉外面，界面据此更新统计而不必等整轮结束
		assert.deepEqual(
			hooks.events.filter((event) => event.type === "usage_recorded").length,
			1,
		);
		const recorded = hooks.events.find((event) => event.type === "usage_recorded");
		assert.ok(recorded?.type === "usage_recorded" && recorded.kind === "turn");
		assert.equal(recorded?.type === "usage_recorded" ? recorded.tokens : 0, STOP.total);
	});

	it("规则内容变化时作为新的系统分段写进会话", async () => {
		let rules = "Use npm test.";
		const hooks = {
			events: [] as AgentEvent[],
			session: new MemorySession(),
			tools: makeTools(),
			instructions: () => [{ label: "AGENTS.md", text: rules }],
		};
		const driver = depsOf(
			[
				{ content: [{ type: "text", text: "one" }] },
				{ content: [{ type: "text", text: "two" }] },
			],
			hooks,
		);

		await driver.run("first", SIGNAL);
		const first = hooks.session.entries.filter((entry) => entry.type === "system").at(-1);
		if (first?.type !== "system") throw new Error("expected a system entry");
		assert.ok(first.sections["instructions"]?.includes("Use npm test."));

		rules = "Use pnpm test.";
		await driver.run("second", SIGNAL);
		const last = hooks.session.entries.filter((entry) => entry.type === "system").at(-1);
		if (last?.type !== "system") throw new Error("expected a system entry");
		assert.ok(last.sections["instructions"]?.includes("Use pnpm test."));
	});

	it("请求重试时发出 retrying 事件", async () => {
		const hooks = {
			events: [] as AgentEvent[],
			session: new MemorySession(),
			tools: makeTools(),
			onRequest: (request: LlmRequest) => request.onRetry?.(2, "temporary failure"),
		};
		await depsOf([{ content: [{ type: "text", text: "ok" }], usage: STOP }], hooks).run("x", SIGNAL);

		assert.ok(
			hooks.events.some(
				(event) => event.type === "retrying" && event.attempt === 2 && event.reason === "temporary failure",
			),
		);
	});

	it("Plan 模式用只读 preamble 构造请求", async () => {
		const hooks = {
			events: [] as AgentEvent[],
			session: new MemorySession(),
			tools: makeTools(),
			requests: [] as LlmRequest[],
			planMode: true,
		};
		await depsOf([{ content: [{ type: "text", text: "planned" }], usage: STOP }], hooks).run("plan it", SIGNAL);

		const system = hooks.requests[0]?.system ?? "";
		assert.ok(system.includes("You are in Plan mode"));
		assert.equal(system.includes("Do not stop at a plan"), false);
	});

	it("撤销提醒只进入下一轮提示词", async () => {
		let notice: string | undefined = "The working tree was rolled back.";
		const hooks = {
			events: [] as AgentEvent[],
			session: new MemorySession(),
			tools: makeTools(),
			requests: [] as LlmRequest[],
			undoNotice: () => {
				const current = notice;
				notice = undefined;
				return current;
			},
		};
		await depsOf([{ content: [{ type: "text", text: "ok" }], usage: STOP }], hooks).run("next", SIGNAL);

		const system = hooks.requests[0]?.system ?? "";
		assert.ok(system.includes("Working tree update:"));
		assert.ok(system.includes("rolled back"));
	});

	it("带图片的输入原样写进会话并进入下一次请求", async () => {
		const hooks = {
			events: [] as AgentEvent[],
			session: new MemorySession(),
			tools: makeTools(),
			requests: [] as LlmRequest[],
		};
		const content = [
			{ type: "text" as const, text: "look" },
			{ type: "image" as const, data: "AAAA", mimeType: "image/png" },
		];
		await depsOf([{ content: [{ type: "text", text: "ok" }], usage: STOP }], hooks).run(content, SIGNAL);

		const stored = hooks.session.entries.find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		assert.ok(stored?.type === "message" && stored.message.role === "user");
		assert.deepEqual(stored.message.content, content);
		assert.deepEqual(
			hooks.requests[0]?.messages.find((message) => message.role === "user"),
			{ role: "user", content },
		);
	});

	it("工具调用:结果写回再起一回合", async () => {
		const calls: string[] = [];
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools({ calls }) };
		await depsOf(
			[
				{ content: [toolCall("c1", "echo", { x: 1 })], usage: STOP },
				{ content: [{ type: "text", text: "done" }], usage: STOP },
			],
			hooks,
		).run("go", SIGNAL);

		assert.deepEqual(calls, ['echo:{"x":1}']);
		// 参数流式生成阶段先给界面一个「正在写工具调用」的信号
		assert.ok(
			hooks.events.some((event) => event.type === "writing_tool_call" && event.name === "echo"),
		);
		// 工具循环里的每一次请求都记一笔，界面因此能在轮次中途更新统计
		assert.deepEqual(
			hooks.events.filter((event) => event.type === "usage_recorded").length,
			2,
		);
		const toolResult = hooks.session.entries.find(
			(entry): entry is SessionEntry & { type: "message"; message: { role: "toolResult"; content: string; isError: boolean } } =>
				entry.type === "message" && entry.message.role === "toolResult",
		);
		assert.ok(toolResult);
		assert.deepEqual(
			{ content: toolResult.message.content, isError: toolResult.message.isError },
			{ content: "tool-outcome", isError: false },
		);
	});

	it("length 截断:工具不执行,失败结果照写", async () => {
		const calls: string[] = [];
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools({ calls }) };
		await depsOf(
			[
				{ content: [toolCall("c1", "echo", {})], stopReason: "length", usage: STOP },
				{ content: [{ type: "text", text: "after" }], usage: STOP },
			],
			hooks,
		).run("x", SIGNAL);

		assert.equal(calls.length, 0);
		const toolResult = hooks.session.entries.find(
			(entry): entry is SessionEntry & { type: "message"; message: { role: "toolResult"; content: string; isError: boolean } } =>
				entry.type === "message" && entry.message.role === "toolResult",
		);
		assert.ok(toolResult);
		assert.equal(toolResult.message.isError, true);
		assert.match(toolResult.message.content, /cut off by the output limit/);
	});

	it("错误与中止:落具体事件,不再续回合", async () => {
		const errorHooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		await depsOf([{ content: [], stopReason: "error", errorMessage: "boom", usage: STOP }], errorHooks).run("x", SIGNAL);
		assert.ok(errorHooks.events.some((event) => event.type === "error" && event.message === "boom"));

		const abortHooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		await depsOf([{ content: [], stopReason: "aborted" }], abortHooks).run("x", SIGNAL);
		assert.ok(abortHooks.events.some((event) => event.type === "aborted"));
	});

	it("外部信号已中止时，本次请求的信号一开始就是中止的", async () => {
		const hooks = {
			events: [] as AgentEvent[],
			session: new MemorySession(),
			tools: makeTools(),
			requests: [] as LlmRequest[],
		};
		const controller = new AbortController();
		controller.abort();

		await depsOf([{ content: [], stopReason: "aborted" }], hooks).run("x", controller.signal);

		// 监听器不会为已经中止的 signal 触发，不先看一眼的话这一次请求会照常发出去
		assert.equal(hooks.requests[0]?.signal.aborted, true);
	});

	it("中断前已经收到的回答写进会话,并说明它是断的", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		await depsOf(
			[
				{
					content: [{ type: "text", text: "我打算先读" }],
					stopReason: "error",
					errorMessage: "the connection was closed before the response finished",
				},
			],
			hooks,
		).run("x", SIGNAL);

		const assistant = hooks.session.entries.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
		assert.deepEqual(assistant.message.content, [
			{ type: "text", text: "我打算先读" },
			{
				type: "text",
				text: "[the response was cut off: the connection was closed before the response finished]",
			},
		]);
	});

	it("中断时未执行的工具调用不写进会话,只在提示里说明", async () => {
		const calls: string[] = [];
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools({ calls }) };
		await depsOf(
			[
				{
					content: [
						{ type: "text", text: "让我读一下" },
						{ type: "toolCall", id: "c1", name: "echo", arguments: {} },
					],
					stopReason: "aborted",
				},
			],
			hooks,
		).run("x", SIGNAL);

		assert.equal(calls.length, 0);
		const assistant = hooks.session.entries.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
		// 没有对应结果的工具调用会让下一次请求不合法，所以只留文本与提示
		assert.deepEqual(assistant.message.content, [
			{ type: "text", text: "让我读一下" },
			{
				type: "text",
				text: "[the response was cut off: the response stopped; 1 tool request(s) in it were not executed]",
			},
		]);
	});

	it("参数不是合法 JSON 时直接回错,不执行", async () => {
		const calls: string[] = [];
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools({ calls }) };
		await depsOf(
			[
				{ content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {}, argumentsError: "bad json" }], usage: STOP },
				{ content: [{ type: "text", text: "ok" }], usage: STOP },
			],
			hooks,
		).run("x", SIGNAL);
		assert.equal(calls.length, 0);
		const toolResult = hooks.session.entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		assert.ok(toolResult && toolResult.type === "message" && toolResult.message.role === "toolResult");
		assert.equal(toolResult.message.isError, true);
	});
});

describe("上下文压缩接合", () => {
	function compactorFake(
		outcome: Promise<CompactionResult> | CompactionResult,
		options: { shouldCompact?: boolean; plan?: number } = {},
	): Compactor {
		const set = { ok: false } as CompactionResult;
		return {
			provider: "p",
			model: "m1",
			shouldCompact: () => options.shouldCompact ?? true,
			plan: (messages: readonly LlmMessage[]) => Math.min(messages.length, options.plan ?? 1),
			summarize: async () => await Promise.resolve(outcome ?? set),
		} as unknown as Compactor;
	}

	it("该压就压:写压缩条目,用量另行记", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		const compactor = compactorFake({
			ok: true,
			summary: "the summary",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			cost: 0.001,
		});
		// 先给会话放一条足够长的消息,让压缩留意它们
		await hooks.session.append({ type: "message", message: { role: "user", content: "old long content ".repeat(50) } } as never);
		await depsOf([{ content: [{ type: "text", text: "ok" }], usage: STOP }], { ...hooks, compactor }).run("next", SIGNAL);

		const types = hooks.session.entries.map((entry) => entry.type);
		assert.ok(types.includes("compaction"));
		assert.ok(types.filter((type) => type === "usage").length >= 2); // 压缩那次 + 本轮
		assert.ok(hooks.events.some((event) => event.type === "compaction_start"));
		assert.ok(hooks.events.some((event) => event.type === "compaction_end" && event.tokensAfter > 0));
		// 压缩用量与回合用量分开上报：界面只把 turn 计入本轮 token
		assert.ok(
			hooks.events.some(
				(event) => event.type === "usage_recorded" && event.kind === "compact" && event.tokens === 2,
			),
		);
		assert.ok(hooks.events.some((event) => event.type === "usage_recorded" && event.kind === "turn"));
	});

	it("压缩失败:不阻塞本轮,不写压缩条目", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		const compactor = compactorFake({ ok: false, message: "endpoint refused" });
		await depsOf([{ content: [{ type: "text", text: "ok" }], usage: STOP }], { ...hooks, compactor }).run("x", SIGNAL);
		assert.ok(hooks.events.some((event) => event.type === "compaction_failed" && event.message === "endpoint refused"));
		assert.ok(!hooks.session.entries.some((entry) => entry.type === "compaction"));
		// 本轮照常完成
		assert.ok(hooks.events.some((event) => event.type === "run_end"));
	});

	it("手动压缩不看阈值,直接写摘要", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		const compactor = compactorFake(
			{ ok: true, summary: "forced summary", usage: undefined, cost: undefined },
			// 阈值判断若生效就会什么都不做,以此证明手动压缩绕过了它
			{ shouldCompact: false },
		);
		await hooks.session.append({
			type: "message",
			message: { role: "user", content: "old content" },
		} as never);

		await depsOf([], { ...hooks, compactor }).compact(SIGNAL);

		const entry = hooks.session.entries.find((item) => item.type === "compaction");
		assert.ok(entry?.type === "compaction" && entry.summary === "forced summary");
		assert.ok(hooks.events.some((event) => event.type === "compaction_start"));
		assert.ok(hooks.events.some((event) => event.type === "compaction_end"));
	});

	it("手动压缩没有可压的部分时说明并保持上下文", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		const compactor = compactorFake(
			{ ok: true, summary: "unused", usage: undefined, cost: undefined },
			{ plan: 0 },
		);

		await depsOf([], { ...hooks, compactor }).compact(SIGNAL);

		assert.ok(hooks.events.some((event) => event.type === "compaction_skipped"));
		assert.equal(hooks.session.entries.some((entry) => entry.type === "compaction"), false);
	});

	it("没有压缩器时手动压缩报告失败", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };

		await depsOf([], hooks).compact(SIGNAL);

		assert.ok(
			hooks.events.some(
				(event) => event.type === "compaction_failed" && /context window/.test(event.message),
			),
		);
	});

	it("构造时带上已知上下文规模,首请求不退回估算", async () => {
		const hooks = { events: [] as AgentEvent[], session: new MemorySession(), tools: makeTools() };
		let seen: number | undefined;
		const compactor = {
			provider: "p",
			model: "m1",
			shouldCompact: (tokens: number) => {
				seen = tokens;
				return false;
			},
			plan: () => 0,
			summarize: async () => ({ ok: false, message: "unused" }),
		} as unknown as Compactor;

		await depsOf([{ content: [{ type: "text", text: "ok" }], usage: STOP }], {
			...hooks,
			compactor,
			contextTokens: 12_345,
		}).run("x", SIGNAL);

		assert.equal(seen, 12_345);
	});
});
