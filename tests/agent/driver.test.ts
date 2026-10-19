import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TurnDriver } from "../../src/agent/driver.ts";
import { EventStream } from "../../src/llm/event-stream.ts";
import type { LlmClient, LlmEvent, LlmRequest, LlmResult, LlmStream } from "../../src/llm/client.ts";
import type { LlmContentBlock, LlmMessage, LlmToolCallBlock, LlmUsage } from "../../src/llm/messages.ts";
import type { AgentEvent } from "../../src/agent/events.ts";
import type { CompactionResult, Compactor } from "../../src/agent/compactor.ts";
import type { SessionEntry, SessionState, SessionToolDeclaration } from "../../src/session/port.ts";

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

function depsOf(turns: readonly ScriptedTurn[], hooks: { events: AgentEvent[]; session: MemorySession; tools: ReturnType<typeof makeTools>; compactor?: Compactor; requests?: LlmRequest[] }): TurnDriver {
	const queue = [...turns];
	const client: LlmClient = {
		api: "fake",
		stream: (request: LlmRequest) => {
			hooks.requests?.push(request);
			const turn = queue.shift() ?? { content: [] };
			return scriptedStream(turn);
		},
	};
	return new TurnDriver({
		provider: { id: "p", name: "p", baseUrl: "b", api: undefined, apiKey: undefined, headers: {}, models: [] },
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
	function compactorFake(outcome: Promise<CompactionResult> | CompactionResult): Compactor {
		const set = { ok: false } as CompactionResult;
		return {
			provider: "p",
			model: "m1",
			shouldCompact: () => true,
			plan: (messages: readonly LlmMessage[]) => Math.min(messages.length, 1),
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
});
