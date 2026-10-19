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
