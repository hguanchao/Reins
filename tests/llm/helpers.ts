import type { ModelEntry, ProviderEntry } from "../../src/config/providers-file.ts";
import type { RetryPolicy } from "../../src/llm/retry.ts";

/** 不重试的策略，用于只关心单次请求行为的用例。 */
export const NO_RETRY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1 };

export function makeProvider(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
	return {
		id: "test",
		name: "测试端点",
		baseUrl: "https://api.example.com",
		api: "openai-completions",
		apiKey: undefined,
		headers: {},
		models: [],
		...overrides,
	};
}

export function makeModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		baseUrl: "https://api.example.com",
		reasoning: false,
		thinkingLevelMap: {},
		input: ["text"],
		cost: undefined,
		contextWindow: undefined,
		maxTokens: undefined,
		headers: {},
		...overrides,
	};
}

/** 把若干段文本当作 SSE 响应体。分段位置可以落在事件中间，用来验证跨分片的解析。 */
export function sseResponse(chunks: readonly string[], status = 200): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(body, {
		status,
		headers: { "content-type": "text/event-stream" },
	});
}

/** 把若干对象拼成 SSE 事件流，每行一个 data 字段。 */
export function sseBody(payloads: readonly unknown[]): string {
	return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
}

/** 收集流里的全部增量事件。 */
export async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
