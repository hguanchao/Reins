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
