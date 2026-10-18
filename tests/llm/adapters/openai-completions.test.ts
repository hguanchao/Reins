import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { OpenAiCompletionsClient } from "../../../src/llm/adapters/openai-completions.ts";
import type { LlmRequest } from "../../../src/llm/client.ts";
import type { ModelEntry, ProviderEntry } from "../../../src/config/providers-file.ts";
import type { RetryPolicy } from "../../../src/llm/retry.ts";

const POLICY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1 };
const REAL_FETCH = globalThis.fetch;

interface FetchCall {
	readonly url: string;
	readonly body: Record<string, unknown> | undefined;
}

function provider(): ProviderEntry {
	return { id: "p", name: "p", baseUrl: undefined, api: "openai-completions", apiKey: "k", headers: {}, models: [] };
}

function model(input: readonly ModelEntry["input"][number][] = ["text"]): ModelEntry {
	return {
		id: "m",
		name: "m",
		api: "openai-completions",
		baseUrl: "https://api.example/v1",
		reasoning: false,
		thinkingLevelMap: {},
		input,
		cost: undefined,
		contextWindow: undefined,
		maxTokens: undefined,
		headers: {},
	};
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
	return {
		model: "m",
		system: "sys",
		messages: [],
		tools: [],
		maxTokens: undefined,
		effort: undefined,
		signal: new AbortController().signal,
		...overrides,
	};
}

function respondWith(events: readonly unknown[]): FetchCall[] {
	const calls: FetchCall[] = [];
	const text = events
		.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
		.join("");
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

async function run(client: OpenAiCompletionsClient, input: LlmRequest): Promise<void> {
	const stream = client.stream(input);
	for await (const event of stream) void event;
	await stream.result();
}

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
});

describe("OpenAI 对话补全的图片映射", () => {
	it("图片映射为 image_url，文本与图片保持顺序", async () => {
		const calls = respondWith([
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		await run(
			new OpenAiCompletionsClient(provider(), model(["text", "image"]), POLICY),
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
		assert.equal(calls[0]?.url, "https://api.example/v1/chat/completions");
		assert.deepEqual(messages[1], {
			role: "user",
			content: [
				{ type: "text", text: "what is this" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			],
		});
	});

	it("非视觉模型把图片降级成文本说明", async () => {
		const calls = respondWith([
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		await run(
			new OpenAiCompletionsClient(provider(), model(["text"]), POLICY),
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
		assert.equal(messages[1]?.content, "what is this\n(image omitted: model does not support images)");
	});

	it("纯文本仍按字符串发送", async () => {
		const calls = respondWith([
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		await run(
			new OpenAiCompletionsClient(provider(), model(), POLICY),
			request({ messages: [{ role: "user", content: "hello" }] }),
		);

		const messages = calls[0]?.body?.["messages"] as readonly { role: string; content: unknown }[];
		assert.equal(messages[1]?.content, "hello");
	});
});
