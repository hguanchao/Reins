import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { LlmRequest } from "../../../src/llm/client.ts";
import { OpenAiCompletionsClient } from "../../../src/llm/adapters/openai-completions.ts";
import { NO_RETRY, collect, makeModel, makeProvider, sseBody, sseResponse } from "../helpers.ts";

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Captured {
	url: string;
	init: RequestInit | undefined;
}

let captured: Captured | undefined;

function stubFetch(impl: FetchImpl): void {
	mock.method(globalThis, "fetch", impl);
}

afterEach(() => {
	mock.restoreAll();
	captured = undefined;
});

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
	return {
		model: "test-model",
		system: "你是助手",
		messages: [{ role: "user", content: "你好" }],
		tools: [],
		maxTokens: undefined,
		effort: undefined,
		signal: new AbortController().signal,
		...overrides,
	};
}

function client(
	options: { model?: ReturnType<typeof makeModel>; provider?: ReturnType<typeof makeProvider> } = {},
): OpenAiCompletionsClient {
	return new OpenAiCompletionsClient(
		options.provider ?? makeProvider(),
		options.model ?? makeModel(),
		NO_RETRY,
	);
}

function respond(chunks: readonly unknown[]): void {
	const body = `${sseBody(chunks)}data: [DONE]\n\n`;
	stubFetch(async (url, init) => {
		captured = { url: String(url), init };
		return sseResponse([body]);
	});
}

describe("OpenAI 兼容适配器的请求", () => {
	it("把提示词与前缀消息映射成对话数组", async () => {
		respond([{ choices: [{ delta: { content: "好" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);

		await client()
			.stream(
				request({
					messages: [
						{ role: "user", content: "第一问" },
						{ role: "assistant", content: [{ type: "text", text: "第一答" }] },
						{ role: "user", content: "第二问" },
					],
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as { messages: unknown[] };
		assert.deepEqual(body.messages, [
			{ role: "system", content: "你是助手" },
			{ role: "user", content: "第一问" },
			{ role: "assistant", content: "第一答" },
			{ role: "user", content: "第二问" },
		]);
	});

	it("把工具结果映射成 tool 角色并带上调用编号", async () => {
		respond([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);

		await client()
			.stream(
				request({
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
						},
						{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "内容", isError: false },
					],
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as { messages: Record<string, unknown>[] };
		assert.deepEqual(body.messages[1], {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
		});
		assert.deepEqual(body.messages[2], { role: "tool", content: "内容", tool_call_id: "call_1" });
	});

	it("声明工具、输出上限与思考等级", async () => {
		respond([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);

		await client({ model: makeModel({ thinkingLevelMap: { high: "HIGH" } }) })
			.stream(
				request({
					tools: [
						{
							name: "read",
							description: "读文件",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						},
					],
					maxTokens: 4096,
					effort: "high",
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
		assert.deepEqual(body["tools"], [
			{
				type: "function",
				function: {
					name: "read",
					description: "读文件",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			},
		]);
		assert.equal(body["max_tokens"], 4096);
		assert.equal(body["reasoning_effort"], "HIGH");
		assert.equal(body["stream"], true);
	});

	it("带上密钥头部，未声明密钥时不带", async () => {
		respond([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
		await client({ provider: makeProvider({ apiKey: "sk-1" }) })
			.stream(request())
			.result();
		assert.equal((captured?.init?.headers as Record<string, string>)["authorization"], "Bearer sk-1");

		respond([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
		await client().stream(request()).result();
		assert.equal((captured?.init?.headers as Record<string, string>)["authorization"], undefined);
	});

	it("地址由 baseUrl 补出补全路径", async () => {
		respond([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
		await client().stream(request()).result();
		assert.equal(captured?.url, "https://api.example.com/chat/completions");
	});
});

describe("OpenAI 兼容适配器的响应", () => {
	it("增量事件与最终内容一致", async () => {
		respond([
			{ choices: [{ delta: { content: "你" }, finish_reason: null }] },
			{ choices: [{ delta: { content: "好" }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		]);

		const stream = client().stream(request());
		const events = await collect(stream);
		assert.deepEqual(events, [
			{ type: "text_delta", text: "你" },
			{ type: "text_delta", text: "好" },
		]);

		const result = await stream.result();
		assert.deepEqual(result.content, [{ type: "text", text: "你好" }]);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.errorMessage, undefined);
	});

	it("推理内容走单独的增量", async () => {
		respond([
			{ choices: [{ delta: { reasoning_content: "先想" }, finish_reason: null }] },
			{ choices: [{ delta: { content: "答案" }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		]);

		const stream = client().stream(request());
		const events = await collect(stream);
		assert.deepEqual(events, [
			{ type: "reasoning_delta", text: "先想" },
			{ type: "text_delta", text: "答案" },
		]);
		assert.deepEqual((await stream.result()).content, [
			{ type: "thinking", text: "先想" },
			{ type: "text", text: "答案" },
		]);
	});

	it("工具调用的参数分片被拼成对象", async () => {
		respond([
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] },
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null },
				],
			},
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null },
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]);

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(result.content, [
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
		]);
	});

	it("读取用量", async () => {
		respond([
			{ choices: [{ delta: { content: "x" }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			{
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 3 },
				},
			},
		]);

		const result = await client().stream(request()).result();
		assert.deepEqual(result.usage, { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, total: 15 });
	});

	it("事件被拆在多个网络分片里也能拼回来", async () => {
		const body = sseBody([
			{ choices: [{ delta: { content: "跨分片" }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		]);
		// 从中间切开，且切点落在一个多字节字符的编码中间
		const cut = Math.floor(body.length / 2);
		stubFetch(async () => sseResponse([body.slice(0, cut), body.slice(cut)]));

		const result = await client().stream(request()).result();
		assert.deepEqual(result.content, [{ type: "text", text: "跨分片" }]);
	});
});

describe("OpenAI 兼容适配器的失败路径", () => {
	it("端点返回错误状态时给出结果而不是抛异常", async () => {
		stubFetch(async () => new Response("限流了", { status: 429 }));

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /HTTP 429/);
		assert.match(result.errorMessage ?? "", /限流了/);
	});

	it("流里出现错误对象时中断本轮", async () => {
		stubFetch(async () =>
			sseResponse([sseBody([{ error: { message: "额度不足" } }])]),
		);

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /额度不足/);
	});

	it("没有结束原因的响应按失败处理，避免把截断当成完成", async () => {
		respond([{ choices: [{ delta: { content: "半句话" }, finish_reason: null }] }]);

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /没有给出结束原因/);
	});

	it("已中止的请求标成 aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		stubFetch(async () => {
			throw new Error("已中止");
		});

		const result = await client().stream(request({ signal: controller.signal })).result();
		assert.equal(result.stopReason, "aborted");
	});
});
