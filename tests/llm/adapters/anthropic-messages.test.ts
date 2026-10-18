import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AnthropicMessagesClient } from "../../../src/llm/adapters/anthropic-messages.ts";
import type { LlmRequest } from "../../../src/llm/client.ts";
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
	return { id: "p", name: "p", baseUrl: undefined, api: "anthropic-messages", apiKey: "k", headers: {}, models: [] };
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

async function run(client: AnthropicMessagesClient, input: LlmRequest): Promise<void> {
	const stream = client.stream(input);
	for await (const event of stream) void event;
	await stream.result();
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
			{ type: "text", text: "(image omitted: model does not support images)" },
		]);
	});

	it("只有图片时补一句文字说明，纯文本仍按字符串发送", async () => {
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
			},
		]);

		const plain = respondWith(DONE_EVENTS);
		await run(
			new AnthropicMessagesClient(provider(), model(), POLICY),
			request({ messages: [{ role: "user", content: "hello" }] }),
		);
		const plainMessages = plain[0]?.body?.["messages"] as readonly { content: unknown }[];
		assert.equal(plainMessages[0]?.content, "hello");
	});
});
