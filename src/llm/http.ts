import { createParser } from "eventsource-parser";

import { readVersion } from "../version.ts";
import { delay, isRetryableStatus, retryDelay, type RetryPolicy } from "./retry.ts";

/** 服务端返回非成功状态。带上响应体片段，否则只能看到一行状态码。 */
export class LlmHttpError extends Error {
	readonly status: number;
	/** 服务端要求等多久再来（Retry-After）；没给就是 undefined */
	readonly retryAfterMs: number | undefined;

	constructor(status: number, message: string, retryAfterMs?: number) {
		super(message);
		this.name = "LlmHttpError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface SseRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
	readonly signal: AbortSignal;
	/**
	 * 内容是否已经发完。
	 *
	 * 有些网关把整个流发完就直接掐断连接，不写 chunked 的结束标记，底层只会报「对方关闭了连接」。
	 * 读取中断时问一次这里：答「是」就按正常结束处理，不再把它当失败。
	 */
	readonly complete?: () => boolean;
	/** 决定重试前告知调用方，便于提示「正在重试」 */
	readonly onRetry?: (attempt: number, reason: string) => void;
}

/** 错误响应体只取一段：有些网关会回一整页 HTML。 */
const ERROR_BODY_LIMIT = 2000;

/**
 * 读流期间允许的最长静默。
 *
 * 上游接过连接之后再不出数据是很糟的失败：没有超时的话这一轮会永远挂着，使用者只能按
 * Ctrl+C。300 秒也是参考实现们取的值——足够慢的模型思考完，又不至于让人干等。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * 发一次 POST，把响应体按 SSE 逐条交给 onData。
 *
 * SSE 的切分交给专门的解析器：一条事件可能被拆在多个网络分片里，也可能一个分片里有好几条，
 * 还有多行 data 的写法，自己拆迟早会在某个分片边界上出错。字节到文本的解码也必须是流式的，
 * 否则一个多字节字符被切开就会变成乱码。
 *
 * 等多久再试交给 retryDelay：服务端用 Retry-After 说了算，没说才用退避。
 */
export async function postSse(
	request: SseRequest,
	onData: (data: string) => void,
	policy: RetryPolicy,
	idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<void> {
	let delivered = false;

	for (let attempt = 0; ; attempt += 1) {
		if (request.signal.aborted) throw new Error("Aborted");
		try {
			await postSseOnce(request, (data) => {
				delivered = true;
				onData(data);
			}, idleTimeoutMs);
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
			await delay(
				retryDelay(attempt, policy, error instanceof LlmHttpError ? error.retryAfterMs : undefined),
				request.signal,
			);
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

async function postSseOnce(
	request: SseRequest,
	onData: (data: string) => void,
	idleTimeoutMs: number,
): Promise<void> {
	// 用 Headers 而不是对象：自定义头可能写 User-Agent / user-agent 等不同大小写，
	// Headers 会按 HTTP 的规则归一化，后设置的值覆盖默认值。
	const headers = new Headers({
		"content-type": "application/json",
		accept: "text/event-stream",
		"user-agent": `reins/${readVersion()}`,
	});
	assertHeaderEncodable(request.headers);
	for (const [name, value] of Object.entries(request.headers)) headers.set(name, value);

	const response = await fetch(request.url, {
		method: "POST",
		headers,
		body: JSON.stringify(request.body),
		signal: request.signal,
	});

	if (!response.ok) {
		throw new LlmHttpError(
			response.status,
			await readErrorBody(response),
			retryAfterMsOf(response.headers.get("retry-after")),
		);
	}
	if (response.body === null) {
		throw new LlmHttpError(response.status, "response has no body");
	}

	const parser = createParser({
		onEvent: (event) => {
			if (event.data.length > 0) onData(event.data);
		},
	});
	const decoder = new TextDecoder("utf-8");
	const reader = response.body.getReader();

	// 静默超时不靠信号：取消读取让挂着的 read 立刻有结果，再按超时报错。
	// 这样既不用把两个信号合成一个，也不影响调用方自己的中止。
	let stalled = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdle = (): void => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			stalled = true;
			void reader.cancel();
		}, idleTimeoutMs);
	};

	try {
		armIdle();
		for (;;) {
			const chunk = await readChunk(reader, request);
			if (chunk === undefined) break;
			// 解析与消费放在读之外：那里的报错（例如端点回了形状不对的字段）是内容的问题，
			// 说成「连接被关闭」只会把人带偏
			parser.feed(decoder.decode(chunk, { stream: true }));
			armIdle();
		}
		if (stalled) {
			// 按连接层失败报：一个数据都没收到时可重试，收到了就不再重试（由 postSse 判定）
			throw new TypeError(
				`the upstream sent no data for ${formatElapsed(idleTimeoutMs)}; the connection looks stalled`,
			);
		}
	} finally {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
	}
	// 收尾：把解码器里可能残留的半个字符与解析器里没有换行结尾的最后一条事件放出来
	parser.feed(decoder.decode());
	parser.reset({ consume: true });
}

/**
 * 读一块数据。
 *
 * 连接断掉但内容已经发完时返回 undefined，按正常结束处理；其余断连错误换成能看懂的说法。
 * 只包住读本身：消费数据的代码抛错不是连接的问题。
 */
async function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	request: SseRequest,
): Promise<Uint8Array | undefined> {
	try {
		const { done, value } = await reader.read();
		return done ? undefined : value;
	} catch (error) {
		// 内容已经发完就不算失败：结束标记都收到了，连接收得干不干净不影响这一轮的结果
		if (request.complete?.() === true) return undefined;
		throw describeClose(error);
	}
}

/**
 * 静默了多久。
 *
 * 默认值是几百秒，但测试里会传很小的值，短于一秒时按毫秒写出来，免得显示成「0s」。
 */
function formatElapsed(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`;
}

/**
 * 服务端要求的重试间隔。
 *
 * 两种写法都允许：秒数（含小数）与 HTTP 日期。看不懂就当作没给，退回自己的退避。
 */
function retryAfterMsOf(header: string | null): number | undefined {
	if (header === null) return undefined;
	const text = header.trim();
	if (text.length === 0) return undefined;

	const seconds = Number(text);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

	const date = Date.parse(text);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, date - Date.now());
}

/**
 * 连接中途断掉时的说法。
 *
 * 底层只给一个「terminated」，看不出是上游断了、网关掐了还是本地网络的问题。补一句上下文，
 * 类型保持不变，重试判定仍然认得出来。
 */
function describeClose(error: unknown): unknown {
	if (!(error instanceof TypeError)) return error;
	const cause = error.cause;
	const detail = cause instanceof Error && cause.message.length > 0 ? cause.message : error.message;
	return new TypeError(`the connection was closed before the response finished: ${detail}`);
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

/**
 * 检查请求头能否按 HTTP 的规定编码。
 *
 * 头部只能携带 latin-1 范围内的字符。密钥或自定义表头里出现中文时会在这里被拦下：底层抛出
 * 的原话是「无法转换成长字节串」，既看不出是哪个头部，也看不出该改什么。
 */
function assertHeaderEncodable(headers: Readonly<Record<string, string>>): void {
	for (const [name, value] of Object.entries(headers)) {
		for (let index = 0; index < value.length; index += 1) {
			if (value.charCodeAt(index) <= 0xff) continue;
			throw new Error(
				`Header ${name} has a character at position ${index + 1} outside the range allowed in HTTP headers (latin-1 only).` +
					" Check the apiKey and headers of this provider in providers.json.",
			);
		}
	}
}
