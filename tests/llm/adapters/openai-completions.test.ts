import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";

import { OpenAiCompletionsClient } from "../../../src/llm/adapters/openai-completions.ts";
import type { LlmRequest, LlmResult } from "../../../src/llm/client.ts";
import { assistantText } from "../../../src/llm/messages.ts";
import type { ModelEntry, ProviderEntry } from "../../../src/config/providers-file.ts";
import type { RetryPolicy } from "../../../src/llm/retry.ts";

const POLICY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1 };
const REAL_FETCH = globalThis.fetch;

interface FetchCall {
	readonly url: string;
	readonly body: Record<string, unknown> | undefined;
}

function provider(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
	return {
		id: "p",
		name: "p",
		baseUrl: undefined,
		api: "openai-completions",
		apiKey: "k",
		headers: {},
		promptCacheKey: false,
		models: [],
		...overrides,
	};
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

async function run(client: OpenAiCompletionsClient, input: LlmRequest): Promise<LlmResult> {
	const stream = client.stream(input);
	for await (const event of stream) void event;
	return await stream.result();
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
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
			"[DONE]",
		]);
		await run(
			new OpenAiCompletionsClient(provider(), model(), POLICY),
			request({ messages: [{ role: "user", content: "hello" }] }),
		);

		const messages = calls[0]?.body?.["messages"] as readonly { role: string; content: unknown }[];
		assert.equal(messages[1]?.content, "hello");
	});

	it("输出上限写在模型声明的字段上", async () => {
		const calls = respondWith([
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
			"[DONE]",
		]);
		await run(
			new OpenAiCompletionsClient(provider(), { ...model(), maxTokensField: "max_completion_tokens" }, POLICY),
			request({ maxTokens: 512 }),
		);

		assert.equal(calls[0]?.body?.["max_completion_tokens"], 512);
		assert.equal("max_tokens" in (calls[0]?.body ?? {}), false);

		// 没声明时仍是多数端点认的那个
		const plain = respondWith([
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
			"[DONE]",
		]);
		await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request({ maxTokens: 512 }));
		assert.equal(plain[0]?.body?.["max_tokens"], 512);
	});

	it("兼容端点把没有的字段写成 null 时不崩", async () => {
		// 真实端点的常见形状：每帧都带 "usage": null、"delta": null、finish_reason: null
		respondWith([
			{ choices: [{ delta: { content: "ok" }, finish_reason: null, usage: null }], usage: null, error: null },
			{ choices: [], usage: null },
			{ choices: [{ delta: null }], usage: null },
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
			"[DONE]",
		]);

		const result = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
		assert.equal(result.usage, undefined);
	});

	it("提示词缓存路由字段只发给声明支持的 provider", async () => {
		const events = [
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
			"[DONE]",
		];
		const declined = respondWith(events);
		await run(
			new OpenAiCompletionsClient(provider(), model(), POLICY),
			request({ cacheKey: "sess-1" }),
		);
		assert.equal("prompt_cache_key" in (declined[0]?.body ?? {}), false);

		const accepted = respondWith(events);
		await run(
			new OpenAiCompletionsClient(provider({ promptCacheKey: true }), model(), POLICY),
			request({ cacheKey: "sess-1" }),
		);
		assert.equal(accepted[0]?.body?.["prompt_cache_key"], "sess-1");
	});
});

/**
 * 起一个「把给定分片写完就掐断连接」的端点。
 *
 * 不补 chunked 的结束标记，网关常这么干；底层只会报「对方关闭了连接」。这样既能测「发完
 * 之后的断开」，也能测「中途断开」。
 */
async function cutServer(
	chunks: readonly unknown[],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of chunks) {
			response.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
		}
		setTimeout(() => response.socket?.destroy(), 20);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("终止原因与产出判定", () => {
	it("结束原因只发 [DONE] 时按已产出的内容推断", async () => {
		respondWith([
			{ choices: [{ delta: { content: "你好" } }] },
			"[DONE]",
		]);
		const plain = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());
		assert.equal(plain.stopReason, "stop");
		assert.deepEqual(plain.content, [{ type: "text", text: "你好" }]);

		respondWith([
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] } }] },
			"[DONE]",
		]);
		const toolCall = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());
		assert.equal(toolCall.stopReason, "toolUse");
	});

	it("两个结束标记都没有才算被截断", async () => {
		// 流干净地结束，但没有 finish_reason 也没有 [DONE]
		respondWith([{ choices: [{ delta: { content: "半截" } }] }]);

		const result = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /no finish reason/);
		// 已经收到的内容仍然交出去，界面早就显示过了
		assert.deepEqual(result.content, [{ type: "text", text: "半截" }]);
	});

	it("内容过滤算错误，不算正常收尾", async () => {
		respondWith([
			{ choices: [{ delta: { content: "被拦下的一段" } }] },
			{ choices: [{ delta: {}, finish_reason: "content_filter" }] },
			"[DONE]",
		]);

		const result = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /content filter/);
		assert.deepEqual(result.content, [{ type: "text", text: "被拦下的一段" }]);
	});

	it("空回答算失败，长度截断的空回答仍报截断", async () => {
		respondWith([
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		const empty = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());
		assert.equal(empty.stopReason, "error");
		assert.match(empty.errorMessage ?? "", /empty response/);

		respondWith([
			{ choices: [{ delta: {}, finish_reason: "length" }] },
			"[DONE]",
		]);
		const truncated = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());
		assert.equal(truncated.stopReason, "length");
	});

	it("中途断开连接时保留已经收到的内容", async () => {
		// 收到一段正文之后连接就断了：没有 [DONE]，也没有结束原因
		const endpoint = await cutServer([{ choices: [{ delta: { content: "说了一半" } }] }]);
		globalThis.fetch = REAL_FETCH;

		try {
			const result = await run(
				new OpenAiCompletionsClient(provider(), { ...model(), baseUrl: endpoint.baseUrl }, POLICY),
				request(),
			);

			assert.equal(result.stopReason, "error");
			assert.deepEqual(result.content, [{ type: "text", text: "说了一半" }]);
		} finally {
			await endpoint.close();
		}
	});
});

describe("用量的字段变体", () => {
	function usageOf(result: LlmResult): unknown {
		return result.usage;
	}

	it("缓存命中从 details 里读，输入按净值算", async () => {
		respondWith([
			{ choices: [{ delta: { content: "ok" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1000,
					completion_tokens: 20,
					total_tokens: 1020,
					prompt_tokens_details: { cached_tokens: 800 },
				},
			},
			"[DONE]",
		]);

		const result = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());

		// prompt_tokens 里含着缓存命中的 800：拆出来金额与命中率才不会被算两遍
		assert.deepEqual(usageOf(result), {
			input: 200,
			output: 20,
			cacheRead: 800,
			cacheWrite: 0,
			total: 1020,
		});
	});

	it("平铺的缓存字段也认", async () => {
		respondWith([
			{ choices: [{ delta: { content: "ok" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 60 },
			},
			"[DONE]",
		]);
		const deepseek = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());
		assert.deepEqual(usageOf(deepseek), { input: 40, output: 5, cacheRead: 60, cacheWrite: 0, total: 105 });

		respondWith([
			{ choices: [{ delta: { content: "ok" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 5,
					total_tokens: 105,
					cached_tokens: 25,
					cache_write_tokens: 10,
				},
			},
			"[DONE]",
		]);
		const kimi = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());
		assert.deepEqual(usageOf(kimi), { input: 65, output: 5, cacheRead: 25, cacheWrite: 10, total: 105 });
	});

	it("用量挂在 choice 里时也认", async () => {
		respondWith([
			{
				choices: [
					{
						delta: { content: "ok" },
						finish_reason: "stop",
						usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
					},
				],
			},
			"[DONE]",
		]);

		const result = await run(new OpenAiCompletionsClient(provider(), model(), POLICY), request());

		assert.deepEqual(usageOf(result), { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 });
	});
});

describe("上游发完就掐断连接", () => {
	it("结束标记到手后的断开不算失败，回答照常保留", async () => {
		const endpoint = await cutServer([
			{ choices: [{ delta: { content: "你好" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		// 这条要真的走一遍网络：上面几条用的是替身 fetch
		globalThis.fetch = REAL_FETCH;

		try {
			const stream = new OpenAiCompletionsClient(
				provider(),
				{ ...model(), baseUrl: endpoint.baseUrl },
				POLICY,
			).stream(request());
			const text: string[] = [];
			for await (const event of stream) {
				if (event.type === "text_delta") text.push(event.text);
			}
			const result = await stream.result();

			assert.equal(result.stopReason, "stop");
			assert.equal(result.errorMessage, undefined);
			assert.equal(assistantText({ role: "assistant", content: result.content }), "你好");
			assert.equal(text.join(""), "你好");
		} finally {
			await endpoint.close();
		}
	});
});
