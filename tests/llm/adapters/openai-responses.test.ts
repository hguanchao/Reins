import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { OpenAiResponsesClient } from "../../../src/llm/adapters/openai-responses.ts";
import type { LlmEvent, LlmRequest, LlmResult } from "../../../src/llm/client.ts";
import type { ModelEntry, ProviderEntry } from "../../../src/config/providers-file.ts";
import type { RetryPolicy } from "../../../src/llm/retry.ts";

const POLICY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1 };
const REAL_FETCH = globalThis.fetch;

interface FetchCall {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: Record<string, unknown> | undefined;
}

function provider(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
	return {
		id: "openai",
		name: "OpenAI",
		baseUrl: undefined,
		api: "openai-responses",
		apiKey: "secret",
		headers: {},
		models: [],
		...overrides,
	};
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
	return {
		id: "gpt-5.2",
		name: "GPT-5.2",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap: {},
		input: ["text"],
		cost: undefined,
		contextWindow: undefined,
		maxTokens: undefined,
		headers: {},
		...overrides,
	};
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
	return {
		model: "gpt-5.2",
		system: "",
		messages: [],
		tools: [],
		maxTokens: undefined,
		effort: undefined,
		signal: new AbortController().signal,
		...overrides,
	};
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> | undefined {
	if (typeof init?.body !== "string") return undefined;
	const parsed: unknown = JSON.parse(init.body);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return parsed as Record<string, unknown>;
}

function headersOf(value: RequestInit["headers"]): Record<string, string> {
	if (value === undefined) return {};
	const result: Record<string, string> = {};
	new Headers(value).forEach((entry, name) => {
		result[name] = entry;
	});
	return result;
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

/** 让 fetch 返回一段现成的 SSE 流，并记下请求内容。 */
function respondWith(events: readonly unknown[]): FetchCall[] {
	const calls: FetchCall[] = [];
	const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: urlOf(input), headers: headersOf(init?.headers), body: bodyOf(init) });
		return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return calls;
}

async function run(
	client: OpenAiResponsesClient,
	input: LlmRequest,
): Promise<{ readonly events: readonly LlmEvent[]; readonly result: LlmResult }> {
	const stream = client.stream(input);
	const events: LlmEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

function clientFor(modelOverrides: Partial<ModelEntry> = {}): OpenAiResponsesClient {
	return new OpenAiResponsesClient(provider(), model(modelOverrides), POLICY);
}

const REASONING_SIGNATURE = JSON.stringify({
	type: "reasoning",
	id: "rs_1",
	summary: [{ type: "summary_text", text: "plan" }],
	encrypted_content: "enc",
});

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
});

describe("OpenAI Responses 请求映射", () => {
	it("消息、工具、思考等级与输出上限按协议拼装", async () => {
		const calls = respondWith([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_text.delta", output_index: 0, delta: "ok" },
			{ type: "response.completed", response: { status: "completed" } },
		]);

		const client = new OpenAiResponsesClient(
			provider({ headers: { "x-test": "1" } }),
			model(),
			POLICY,
		);
		const { result } = await run(
			client,
			request({
				system: "be brief",
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", text: "plan", signature: REASONING_SIGNATURE },
							{ type: "text", text: "answer" },
							{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
						],
					},
					{ role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: "ok", isError: false },
				],
				tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
				maxTokens: 8,
				effort: "high",
			}),
		);

		assert.equal(result.stopReason, "stop");
		const call = calls[0];
		assert.ok(call !== undefined);
		assert.equal(call.url, "https://api.openai.com/v1/responses");
		assert.equal(call.headers["authorization"], "Bearer secret");
		assert.equal(call.headers["x-test"], "1");

		const body = call.body;
		assert.ok(body !== undefined);
		assert.equal(body["model"], "gpt-5.2");
		assert.equal(body["instructions"], "be brief");
		assert.equal(body["store"], false);
		assert.equal(body["stream"], true);
		assert.equal(body["max_output_tokens"], 16);
		assert.deepEqual(body["reasoning"], { effort: "high", summary: "auto" });
		assert.deepEqual(body["include"], ["reasoning.encrypted_content"]);
		assert.deepEqual(body["tools"], [
			{ type: "function", name: "read", description: "read a file", parameters: { type: "object" } },
		]);
		assert.deepEqual(body["input"], [
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "plan" }],
				encrypted_content: "enc",
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
				status: "completed",
			},
			{ type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}', id: "fc_1" },
			{ type: "function_call_output", call_id: "call_1", output: "ok" },
		]);
	});

	it("只有思考项的轮次不回放，孤立 reasoning 会被端点拒绝", async () => {
		const calls = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(
			clientFor(),
			request({
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: [{ type: "thinking", text: "plan", signature: REASONING_SIGNATURE }] },
				],
			}),
		);

		const body = calls[0]?.body;
		assert.ok(body !== undefined);
		assert.deepEqual(body["input"], [
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);
	});

	it("其他协议留下的思考签名不会当成 reasoning 回传", async () => {
		const calls = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(
			clientFor(),
			request({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", text: "plan", signature: "anthropic-signature" },
							{ type: "text", text: "answer" },
						],
					},
				],
			}),
		);

		const body = calls[0]?.body;
		assert.ok(body !== undefined);
		assert.deepEqual(body["input"], [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
				status: "completed",
			},
		]);
	});

	it("思考关闭时显式发送 none；声明 off 不支持时不发 reasoning", async () => {
		const calls = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(clientFor(), request());
		assert.deepEqual(calls[0]?.body?.["reasoning"], { effort: "none" });

		const second = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(clientFor({ thinkingLevelMap: { off: null } }), request());
		assert.equal(second[0]?.body?.["reasoning"], undefined);
	});

	it("用户图片映射为 input_image；非视觉模型降级为文本", async () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const content = [
			{ type: "text" as const, text: "what is this" },
			image,
		];

		const vision = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(clientFor({ input: ["text", "image"] }), request({ messages: [{ role: "user", content }] }));
		assert.deepEqual(vision[0]?.body?.["input"], [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "what is this" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
		]);

		const textOnly = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(clientFor({ input: ["text"] }), request({ messages: [{ role: "user", content }] }));
		assert.deepEqual(textOnly[0]?.body?.["input"], [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "what is this" },
					{ type: "input_text", text: "(image omitted: model does not support images)" },
				],
			},
		]);

		const imageOnly = respondWith([{ type: "response.completed", response: { status: "completed" } }]);
		await run(
			clientFor({ input: ["text", "image"] }),
			request({ messages: [{ role: "user", content: [image] }] }),
		);
		assert.deepEqual(imageOnly[0]?.body?.["input"], [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "(see attached image)" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
		]);
	});
});

describe("OpenAI Responses 流式处理", () => {
	it("思考、文本与工具调用按输出项拼成完整结果", async () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_1",
			summary: [{ type: "summary_text", text: "think \n\nmore" }],
			encrypted_content: "enc",
		};
		respondWith([
			{ type: "response.created", response: { id: "resp_1", model: "gpt-5.2" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
			{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think " },
			{ type: "response.reasoning_summary_part.done", output_index: 0 },
			{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "more" },
			{ type: "response.output_item.done", output_index: 0, item: reasoningItem },
			{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
			{ type: "response.output_text.delta", output_index: 1, delta: "hel" },
			{ type: "response.output_text.delta", output_index: 1, delta: "lo" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "hello" }] },
			},
			{
				type: "response.output_item.added",
				output_index: 2,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":' },
			{ type: "response.function_call_arguments.delta", output_index: 2, delta: '"a.ts"}' },
			{
				type: "response.output_item.done",
				output_index: 2,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					model: "gpt-5.2",
					status: "completed",
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						total_tokens: 120,
						input_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
					},
				},
			},
		]);

		const { events, result } = await run(clientFor(), request());

		const reasoning = events
			.filter((event): event is Extract<LlmEvent, { type: "reasoning_delta" }> => event.type === "reasoning_delta")
			.map((event) => event.text);
		assert.deepEqual(reasoning, ["think ", "\n\n", "more"]);
		const text = events
			.filter((event): event is Extract<LlmEvent, { type: "text_delta" }> => event.type === "text_delta")
			.map((event) => event.text);
		assert.deepEqual(text, ["hel", "lo"]);
		assert.deepEqual(
			events.find((event) => event.type === "tool_call_start"),
			{ type: "tool_call_start", index: 2, id: "call_1|fc_1", name: "read" },
		);
		assert.deepEqual(
			events.filter((event) => event.type === "tool_call_delta").map((event) => (event as { argsJson: string }).argsJson),
			['{"path":', '"a.ts"}'],
		);
		assert.deepEqual(events.find((event) => event.type === "tool_call_end"), { type: "tool_call_end", index: 2 });

		assert.deepEqual(result.content, [
			{ type: "thinking", text: "think \n\nmore", signature: JSON.stringify(reasoningItem) },
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
		]);
		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.model, "gpt-5.2");
		assert.deepEqual(result.usage, { input: 65, output: 20, cacheRead: 30, cacheWrite: 5, total: 120 });
	});

	it("工具参数以块结束时的最终值为准", async () => {
		respondWith([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
			{ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"a.ts","content":"x"}' },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: "" },
			},
			{ type: "response.completed", response: { status: "completed" } },
		]);

		const { result } = await run(clientFor(), request());
		assert.deepEqual(result.content, [
			{ type: "toolCall", id: "call_1|fc_1", name: "write", arguments: { path: "a.ts", content: "x" } },
		]);
		assert.equal(result.stopReason, "toolUse");
	});

	it("max_output_tokens 映射为 length，其他不完整原因映射为 error", async () => {
		respondWith([
			{
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		]);
		const truncated = await run(clientFor(), request());
		assert.equal(truncated.result.stopReason, "length");
		assert.equal(truncated.result.errorMessage, undefined);

		respondWith([
			{
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
			},
		]);
		const filtered = await run(clientFor(), request());
		assert.equal(filtered.result.stopReason, "error");
		assert.match(filtered.result.errorMessage ?? "", /content_filter/);
	});

	it("没有终止事件或工具调用未收尾时报错", async () => {
		respondWith([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{" },
		]);
		const cutOff = await run(clientFor(), request());
		assert.equal(cutOff.result.stopReason, "error");
		assert.match(cutOff.result.errorMessage ?? "", /terminal event/);

		respondWith([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{" },
			{ type: "response.completed", response: { status: "completed" } },
		]);
		const unfinished = await run(clientFor(), request());
		assert.equal(unfinished.result.stopReason, "error");
		assert.match(unfinished.result.errorMessage ?? "", /unfinished tool call/);
	});

	it("response.failed 与 error 事件冒泡为 error 结果", async () => {
		respondWith([
			{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } },
		]);
		const failed = await run(clientFor(), request());
		assert.equal(failed.result.stopReason, "error");
		assert.equal(failed.result.errorMessage, "boom");

		respondWith([{ type: "error", message: "upstream exploded" }]);
		const errored = await run(clientFor(), request());
		assert.equal(errored.result.stopReason, "error");
		assert.equal(errored.result.errorMessage, "upstream exploded");
	});
});
