import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { AnthropicMessagesClient } from "../../../src/llm/adapters/anthropic-messages.ts";
import type { LlmRequest } from "../../../src/llm/client.ts";
import { NO_RETRY, makeModel, makeProvider, sseBody, sseResponse } from "../helpers.ts";

interface Captured {
	url: string;
	init: RequestInit | undefined;
}

let captured: Captured | undefined;

function stubFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
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
		maxTokens: 4096,
		effort: undefined,
		signal: new AbortController().signal,
		...overrides,
	};
}

function client(options: Parameters<typeof makeModel>[0] = {}): AnthropicMessagesClient {
	return new AnthropicMessagesClient(
		makeProvider({ api: "anthropic-messages" }),
		makeModel({ api: "anthropic-messages", ...options }),
		NO_RETRY,
	);
}

/** 用一组事件拼出流，并补上收尾事件。 */
function respond(events: readonly unknown[], stopReason = "end_turn"): void {
	const body = sseBody([
		{ type: "message_start", message: { model: "claude-test", usage: { input_tokens: 12 } } },
		...events,
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } },
		{ type: "message_stop" },
	]);
	stubFetch(async (url, init) => {
		captured = { url: String(url), init };
		return sseResponse([body]);
	});
}

describe("Anthropic 适配器的请求", () => {
	it("提示词走 system 字段，版本头与密钥就位", async () => {
		respond([]);
		await client().stream(request()).result();

		const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
		assert.equal(body["system"], "你是助手");
		assert.equal(body["max_tokens"], 4096);
		assert.equal(body["stream"], true);

		const headers = captured?.init?.headers as Record<string, string>;
		assert.equal(headers["anthropic-version"], "2023-06-01");
		assert.equal(captured?.url, "https://api.example.com/v1/messages");
	});

	it("把内容块映射成文本、思考与工具调用", async () => {
		respond([]);
		await client()
			.stream(
				request({
					messages: [
						{
							role: "assistant",
							content: [
								{ type: "thinking", text: "推理", signature: "sig-1" },
								{ type: "text", text: "说明" },
								{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } },
							],
						},
					],
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as { messages: unknown[] };
		assert.deepEqual(body.messages, [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "推理", signature: "sig-1" },
					{ type: "text", text: "说明" },
					{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } },
				],
			},
		]);
	});

	it("缺签名的思考块不回传，避免发出必然被拒的请求", async () => {
		respond([]);
		await client()
			.stream(
				request({
					messages: [
						{ role: "assistant", content: [{ type: "thinking", text: "没有签名的推理" }] },
						{ role: "user", content: "继续" },
					],
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as { messages: unknown[] };
		assert.deepEqual(body.messages, [
			{ role: "user", content: [{ type: "text", text: "继续" }] },
		]);
	});

	it("连续的工具结果合并进同一条 user 消息", async () => {
		respond([]);
		await client()
			.stream(
				request({
					messages: [
						{ role: "toolResult", toolCallId: "t1", toolName: "read", content: "甲", isError: false },
						{ role: "toolResult", toolCallId: "t2", toolName: "read", content: "乙", isError: true },
					],
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as { messages: unknown[] };
		assert.deepEqual(body.messages, [
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "甲", is_error: false },
					{ type: "tool_result", tool_use_id: "t2", content: "乙", is_error: true },
				],
			},
		]);
	});

	it("工具用 input_schema 声明", async () => {
		respond([]);
		await client()
			.stream(
				request({
					tools: [{ name: "read", description: "读文件", parameters: { type: "object" } }],
				}),
			)
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
		assert.deepEqual(body["tools"], [
			{ name: "read", description: "读文件", input_schema: { type: "object" } },
		]);
	});

	it("思考等级按自适应思考的形式发送", async () => {
		respond([]);
		await client({ thinkingLevelMap: { high: "HIGH" } })
			.stream(request({ effort: "high" }))
			.result();

		const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
		assert.deepEqual(body["thinking"], { type: "adaptive", effort: "HIGH" });
	});

	it("未声明输出上限时明确报错，不代填一个数字", async () => {
		respond([]);
		const result = await client().stream(request({ maxTokens: undefined })).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /没有声明 maxTokens/);
	});
});

describe("Anthropic 适配器的响应", () => {
	it("文本增量与最终内容一致", async () => {
		respond([
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
			{ type: "content_block_stop", index: 0 },
		]);

		const stream = client().stream(request());
		const events: unknown[] = [];
		for await (const event of stream) events.push(event);
		assert.deepEqual(events, [
			{ type: "text_delta", text: "你" },
			{ type: "text_delta", text: "好" },
			{ type: "tool_call_end", index: 0 },
		]);

		const result = await stream.result();
		assert.deepEqual(result.content, [{ type: "text", text: "你好" }]);
		assert.equal(result.model, "claude-test");
	});

	it("思考块的增量与签名都被记下", async () => {
		respond([
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "推理" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-9" } },
		]);

		const result = await client().stream(request()).result();
		assert.deepEqual(result.content, [{ type: "thinking", text: "推理", signature: "sig-9" }]);
	});

	it("工具调用在块结束时解析参数", async () => {
		respond(
			[
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "read" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"path":' },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
				},
				{ type: "content_block_stop", index: 0 },
			],
			"tool_use",
		);

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(result.content, [
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
		]);
	});

	it("用量由开始与收尾两个事件合起来", async () => {
		respond([]);
		const result = await client().stream(request()).result();
		assert.deepEqual(result.usage, { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, total: 19 });
	});
});

describe("Anthropic 适配器的失败路径", () => {
	it("端点返回错误状态时给出结果而不是抛异常", async () => {
		stubFetch(async () => new Response("不认识的字段", { status: 400 }));

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /HTTP 400/);
		assert.match(result.errorMessage ?? "", /不认识的字段/);
	});

	it("流里出现错误事件时中断本轮", async () => {
		stubFetch(async () => sseResponse([sseBody([{ type: "error", error: { message: "超长了" } }])]));

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /超长了/);
	});

	it("没有结束原因的响应按失败处理", async () => {
		const body = sseBody([
			{ type: "message_start", message: { model: "claude-test" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半句" } },
		]);
		stubFetch(async () => sseResponse([body]));

		const result = await client().stream(request()).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /没有给出结束原因/);
	});
});
