import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { describe, it } from "node:test";

import { postSse } from "../../src/llm/http.ts";
import { readVersion } from "../../src/version.ts";

/** 起一个本地 SSE 端点，抓取这次请求的 User-Agent。 */
async function captureUserAgent(headers?: Record<string, string>): Promise<string | undefined> {
	let userAgent: string | undefined;

	const server = createServer((request, response) => {
		const value = request.headers["user-agent"];
		userAgent = typeof value === "string" ? value : undefined;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			connection: "close",
		});
		response.end("data: [DONE]\n\n");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	try {
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");

		await postSse(
			{
				url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
				headers: headers ?? {},
				body: {},
				signal: new AbortController().signal,
			},
			() => {},
			{ maxRetries: 0, baseDelayMs: 1 },
		);

		return userAgent;
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("上游请求头", () => {
	it("没有自定义 UA 时使用 reins/<version>", async () => {
		assert.equal(await captureUserAgent(), `reins/${readVersion()}`);
	});

	it("provider/model 配置的 UA 覆盖默认值，大小写不敏感", async () => {
		assert.equal(await captureUserAgent({ "User-Agent": "custom/1.0" }), "custom/1.0");
	});
});

/**
 * 起一个「把 SSE 写完就掐断连接」的端点。
 *
 * 有些网关发完最后一条事件直接把 socket 关掉，不补 chunked 的结束标记；底层那时只会报
 * 「对方关闭了连接」。调用方要用 complete 自己判断这算不算失败。
 */
async function serveThenCut(
	chunks: readonly string[],
): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of chunks) response.write(`data: ${chunk}\n\n`);
		setTimeout(() => response.socket?.destroy(), 20);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");

	return {
		url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("上游发完就断开连接", () => {
	it("内容已经发完时按正常结束处理", async () => {
		const endpoint = await serveThenCut(['{"a":1}', "[DONE]"]);
		const seen: string[] = [];

		try {
			await postSse(
				{
					url: endpoint.url,
					headers: {},
					body: {},
					signal: new AbortController().signal,
					complete: () => seen.includes("[DONE]"),
				},
				(data) => seen.push(data),
				{ maxRetries: 0, baseDelayMs: 1 },
			);
		} finally {
			await endpoint.close();
		}

		assert.deepEqual(seen, ['{"a":1}', "[DONE]"]);
	});

	it("内容没发完就断开时报出可读的错，已收到的数据仍然交付", async () => {
		const endpoint = await serveThenCut(['{"a":1}']);
		const seen: string[] = [];
		let error: unknown;

		try {
			await postSse(
				{
					url: endpoint.url,
					headers: {},
					body: {},
					signal: new AbortController().signal,
					complete: () => false,
				},
				(data) => seen.push(data),
				{ maxRetries: 0, baseDelayMs: 1 },
			);
		} catch (caught) {
			error = caught;
		} finally {
			await endpoint.close();
		}

		assert.deepEqual(seen, ['{"a":1}']);
		assert.ok(error instanceof TypeError);
		assert.match(error.message, /connection was closed before the response finished/);
	});
});

describe("静默超时与重试间隔", () => {
	/** 起一个由回调决定怎么响应的端点。 */
	async function serve(
		handle: (response: ServerResponse, count: number) => void,
	): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
		let count = 0;
		const server = createServer((_request, response) => {
			count += 1;
			handle(response, count);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");

		return {
			url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
			count: () => count,
			close: async () => {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
	}

	it("上游收下请求后再不吐数据时按静默超时失败", async () => {
		const endpoint = await serve((response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"a":1}\n\n');
			// 之后既不发数据也不结束：没有超时的话这里会永远挂着
		});
		const seen: string[] = [];

		try {
			await assert.rejects(
				() =>
					postSse(
						{ url: endpoint.url, headers: {}, body: {}, signal: new AbortController().signal },
						(data) => seen.push(data),
						{ maxRetries: 0, baseDelayMs: 1 },
						200,
					),
				/stalled/,
			);
		} finally {
			await endpoint.close();
		}

		assert.deepEqual(seen, ['{"a":1}']);
	});

	it("服务端给的 Retry-After 决定等多久，等到之后照常继续", async () => {
		const endpoint = await serve((response, count) => {
			if (count === 1) {
				response.writeHead(429, { "content-type": "text/plain", "retry-after": "0.05" });
				response.end("slow down");
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("data: [DONE]\n\n");
		});
		const seen: string[] = [];
		const retries: string[] = [];

		try {
			await postSse(
				{
					url: endpoint.url,
					headers: {},
					body: {},
					signal: new AbortController().signal,
					onRetry: (attempt, reason) => retries.push(`${attempt}:${reason}`),
				},
				(data) => seen.push(data),
				{ maxRetries: 2, baseDelayMs: 5000 },
			);
		} finally {
			await endpoint.close();
		}

		assert.equal(endpoint.count(), 2);
		assert.deepEqual(seen, ["[DONE]"]);
		assert.equal(retries.length, 1);
		assert.match(retries[0] ?? "", /HTTP 429/);
	});

	it("Retry-After 要求等得超出上限时立刻报出来，不干等", async () => {
		const endpoint = await serve((response) => {
			response.writeHead(429, { "content-type": "text/plain", "retry-after": "3600" });
			response.end("slow down");
		});

		try {
			await assert.rejects(
				() =>
					postSse(
						{ url: endpoint.url, headers: {}, body: {}, signal: new AbortController().signal },
						() => {},
						{ maxRetries: 3, baseDelayMs: 1 },
					),
				/asked to retry in 3600s/,
			);
		} finally {
			await endpoint.close();
		}

		// 没有真的去等：只请求了一次就把情况报出来了
		assert.equal(endpoint.count(), 1);
	});

	it("首块的 BOM 不影响第一条事件", async () => {
		const endpoint = await serve((response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("\uFEFFdata: {\"first\":1}\n\ndata: {\"second\":2}\n\n");
		});
		const seen: string[] = [];

		try {
			await postSse(
				{ url: endpoint.url, headers: {}, body: {}, signal: new AbortController().signal },
				(data) => seen.push(data),
				{ maxRetries: 0, baseDelayMs: 1 },
			);
		} finally {
			await endpoint.close();
		}

		assert.deepEqual(seen, ['{"first":1}', '{"second":2}']);
	});

	it("消费数据时抛错不会被说成连接问题", async () => {
		const endpoint = await serve((response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end('data: {"usage":null}\n\n');
		});
		let error: unknown;

		try {
			await postSse(
				{ url: endpoint.url, headers: {}, body: {}, signal: new AbortController().signal },
				() => {
					throw new TypeError("Cannot read properties of null (reading 'prompt_tokens_details')");
				},
				{ maxRetries: 0, baseDelayMs: 1 },
			);
		} catch (caught) {
			error = caught;
		} finally {
			await endpoint.close();
		}

		// 这句报错是内容的问题，说成「连接被关闭」只会把人带偏
		assert.ok(error instanceof TypeError);
		assert.match(error.message, /Cannot read properties of null/);
		assert.doesNotMatch(error.message, /connection was closed/);
	});
});
