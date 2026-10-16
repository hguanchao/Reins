import { createParser } from "eventsource-parser";

import { backoffDelay, delay, isRetryableStatus, type RetryPolicy } from "./retry.ts";

/** 服务端返回非成功状态。带上响应体片段，否则只能看到一行状态码。 */
export class LlmHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LlmHttpError";
		this.status = status;
	}
}

export interface SseRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
	readonly signal: AbortSignal;
	/** 决定重试前告知调用方，便于提示「正在重试」 */
	readonly onRetry?: (attempt: number, reason: string) => void;
}

/** 错误响应体只取一段：有些网关会回一整页 HTML。 */
const ERROR_BODY_LIMIT = 2000;

/**
 * 发一次 POST，把响应体按 SSE 逐条交给 onData。
 *
 * SSE 的切分交给专门的解析器：一条事件可能被拆在多个网络分片里，也可能一个分片里有好几条，
 * 还有多行 data 的写法，自己拆迟早会在某个分片边界上出错。字节到文本的解码也必须是流式的，
 * 否则一个多字节字符被切开就会变成乱码。
 */
export async function postSse(
	request: SseRequest,
	onData: (data: string) => void,
	policy: RetryPolicy,
): Promise<void> {
	let delivered = false;

	for (let attempt = 0; ; attempt += 1) {
		if (request.signal.aborted) throw new Error("已中止");
		try {
			await postSseOnce(request, (data) => {
				delivered = true;
				onData(data);
			});
			return;
		} catch (error) {
			if (
				delivered ||
				request.signal.aborted ||
				attempt >= policy.maxRetries ||
				!isRetryable(error)
			) {
				throw error;
			}
			request.onRetry?.(attempt + 1, describeError(error));
			await delay(backoffDelay(attempt, policy.baseDelayMs), request.signal);
		}
	}
}

/** 连接层面失败通常抛 TypeError；响应码失败另有类型。 */
function isRetryable(error: unknown): boolean {
	if (error instanceof LlmHttpError) return isRetryableStatus(error.status);
	return error instanceof TypeError;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function postSseOnce(request: SseRequest, onData: (data: string) => void): Promise<void> {
	const response = await fetch(request.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
			...request.headers,
		},
		body: JSON.stringify(request.body),
		signal: request.signal,
	});

	if (!response.ok) {
		throw new LlmHttpError(response.status, await readErrorBody(response));
	}
	if (response.body === null) {
		throw new LlmHttpError(response.status, "响应没有内容");
	}

	const parser = createParser({
		onEvent: (event) => {
			if (event.data.length > 0) onData(event.data);
		},
	});
	const decoder = new TextDecoder("utf-8");
	const reader = response.body.getReader();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parser.feed(decoder.decode(value, { stream: true }));
	}
	// 收尾：把解码器里可能残留的半个字符与解析器里没有换行结尾的最后一条事件放出来
	parser.feed(decoder.decode());
	parser.reset({ consume: true });
}

async function readErrorBody(response: Response): Promise<string> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return `HTTP ${response.status}`;
	}
	const trimmed = text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
	return `HTTP ${response.status}${trimmed.length > 0 ? ` ${trimmed}` : ""}`;
}
