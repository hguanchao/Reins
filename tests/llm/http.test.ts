import assert from "node:assert/strict";
import { createServer } from "node:http";
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
