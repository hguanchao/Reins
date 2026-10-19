import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AnthropicMessagesClient } from "../../../src/llm/adapters/anthropic-messages.ts";
import type { LlmEvent, LlmRequest, LlmResult } from "../../../src/llm/client.ts";
import type { ModelEntry, ProviderEntry } from "../../../src/config/providers-file.ts";
import type { RetryPolicy } from "../../../src/llm/retry.ts";

const POLICY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1 };
const REAL_FETCH = globalThis.fetch;

interface FetchCall {
	readonly url: string;
	readonly body: Record<string, unknown> | undefined;
}

const DONE_EVENTS = [
	{ type: "message_start", message: { usage: {} } },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
];

function provider(): ProviderEntry {
	return { id: "p", name: "p", baseUrl: undefined, api: "anthropic-messages", apiKey: "k", headers: {}, promptCacheKey: false, models: [] };
}

function model(input: readonly ModelEntry["input"][number][] = ["text"]): ModelEntry {
	return {
		id: "m",
		name: "m",
		api: "anthropic-messages",
		baseUrl: "https://api.example",
		reasoning: false,
		thinkingLevelMap: {},
		input,
		cost: undefined,
		contextWindow: undefined,
		maxTokens: 100,
		maxTokensField: "max_tokens",
		headers: {},
	};
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
	return {
		model: "m",
		system: "sys",
		messages: [],
		tools: [],
		maxTokens: 100,
		effort: undefined,
		signal: new AbortController().signal,
		...overrides,
	};
}

function respondWith(events: readonly unknown[]): FetchCall[] {
	const calls: FetchCall[] = [];
	const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url,
			body:
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: undefined,
		});
		return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return calls;
}

async function run(
	client: AnthropicMessagesClient,
	input: LlmRequest,
): Promise<{ result: LlmResult; events: readonly LlmEvent[] }> {
	const stream = client.stream(input);
	const events: LlmEvent[] = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
});

describe("Anthropic Messages 的图片映射", () => {
	it("图片映射为 base64 内容块，文本与图片保持顺序", async () => {
		const calls = respondWith(DONE_EVENTS);
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		await run(
			new AnthropicMessagesClient(provider(), model(["text", "image"]), POLICY),
			request({
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "what is this" }, image],
					},
				],
			}),
		);

		const messages = calls[0]?.body?.["messages"] as readonly { role: string; content: unknown }[];
		assert.equal(calls[0]?.url, "https://api.example/v1/messages");
		assert.deepEqual(messages[0], {
			role: "user",
			content: [
				{ type: "text", text: "what is this" },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "AAAA" },
					cache_control: { type: "ephemeral" },
				},
			],
		});
	});

	it("非视觉模型把图片降级成文本说明", async () => {
		const calls = respondWith(DONE_EVENTS);
		await run(
			new AnthropicMessagesClient(provider(), model(["text"]), POLICY),
			request({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "what is this" },
							{ type: "image", data: "AAAA", mimeType: "image/png" },
						],
					},
				],
			}),
		);

		const messages = calls[0]?.body?.["messages"] as readonly { role: string; content: unknown }[];
		assert.deepEqual(messages[0]?.content, [
			{ type: "text", text: "what is this" },
			{
				type: "text",
				text: "(image omitted: model does not support images)",
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("只有图片时补一句文字说明，纯文本改块形式以挂上缓存断点", async () => {
		const imageOnly = respondWith(DONE_EVENTS);
		await run(
			new AnthropicMessagesClient(provider(), model(["text", "image"]), POLICY),
			request({
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					},
				],
			}),
		);
		const imageMessages = imageOnly[0]?.body?.["messages"] as readonly { content: unknown }[];
		assert.deepEqual(imageMessages[0]?.content, [
			{ type: "text", text: "(see attached image)" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "AAAA" },
				cache_control: { type: "ephemeral" },
			},
		]);

		const plain = respondWith(DONE_EVENTS);
		await run(
			new AnthropicMessagesClient(provider(), model(), POLICY),
			request({ messages: [{ role: "user", content: "hello" }] }),
		);
		const plainMessages = plain[0]?.body?.["messages"] as readonly { content: unknown }[];
		assert.deepEqual(plainMessages[0]?.content, [
			{ type: "text", text: "hello", cache_control: { type: "ephemeral" } },
		]);
	});

	it("system 与最后一条消息各带一个缓存断点", async () => {
		const calls = respondWith(DONE_EVENTS);
		await run(
			new AnthropicMessagesClient(provider(), model(), POLICY),
			request({
				system: "be brief",
				tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
					{ role: "toolResult", toolCallId: "c1", toolName: "read", content: "ok", isError: false },
				],
			}),
		);

		const body = calls[0]?.body;
		// 断点之前的整段前缀（工具 + system）进缓存，命中后不再按全额输入计费
		assert.deepEqual(body?.["system"], [
			{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
		]);
		const messages = body?.["messages"] as readonly { content: readonly unknown[] }[];
		assert.deepEqual(messages.at(-1)?.content, [
			{
				type: "tool_result",
				tool_use_id: "c1",
				content: "ok",
				is_error: false,
				cache_control: { type: "ephemeral" },
			},
		]);
	});
});

describe("Anthropic Messages 的收尾判定", () => {
	const START = { type: "message_start", message: { model: "m", usage: { input_tokens: 5 } } };
	const STOP = [
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];

	it("块结束时只有工具调用发结束事件", async () => {
		respondWith([
			START,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
			{ type: "content_block_stop", index: 0 },
			...STOP,
		]);

		const { result, events } = await run(
			new AnthropicMessagesClient(provider(), model(), POLICY),
			request(),
		);

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
		// 文本块收尾不是工具调用收尾，界面不该看到一次假的工具结束
		assert.equal(events.some((event) => event.type === "tool_call_end"), false);
	});

	it("空回答算失败，不当成一轮空白对话", async () => {
		respondWith([START, ...STOP]);

		const { result } = await run(new AnthropicMessagesClient(provider(), model(), POLICY), request());

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /empty response/);
	});

	it("端点把没有的字段写成 null 时不崩", async () => {
		respondWith([
			{ type: "message_start", message: { model: "m", usage: null } },
			{ type: "content_block_start", index: 0, content_block: null },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: null },
			{ type: "message_stop" },
		]);

		const { result } = await run(new AnthropicMessagesClient(provider(), model(), POLICY), request());

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
		assert.equal(result.usage, undefined);
	});
});
