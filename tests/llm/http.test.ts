import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { LlmHttpError, postSse } from "../../src/llm/http.ts";
import type { RetryPolicy } from "../../src/llm/retry.ts";
import { sseResponse } from "./helpers.ts";

const NO_RETRY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1 };
const QUICK_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 1 };

let attempts = 0;

/** 计数放在替身内部：装替身不算一次尝试，真正的请求才算。 */
function stub(impl: () => Promise<Response>): void {
	mock.method(globalThis, "fetch", () => {
		attempts += 1;
		return impl();
	});
}

afterEach(() => {
	mock.restoreAll();
	attempts = 0;
});

function request(overrides: Record<string, unknown> = {}): Parameters<typeof postSse>[0] {
	return {
		url: "https://api.example.com/chat",
		headers: {},
		body: { hello: "world" },
		signal: new AbortController().signal,
		...overrides,
	} as Parameters<typeof postSse>[0];
}

describe("事件流请求", () => {
	it("把每条事件的数据交给回调", async () => {
		stub(async () => sseResponse(["data: 一\n\ndata: 二\n\n"]));
		const received: string[] = [];
		await postSse(request(), (data) => received.push(data), NO_RETRY);
		assert.deepEqual(received, ["一", "二"]);
	});

	it("空数据的事件被跳过", async () => {
		stub(async () => sseResponse(["data:\n\n", "data: 有内容\n\n"]));
		const received: string[] = [];
		await postSse(request(), (data) => received.push(data), NO_RETRY);
		assert.deepEqual(received, ["有内容"]);
	});

	it("事件跨网络分片时仍能拼回来", async () => {
		stub(async () => sseResponse(["data: 前", "半\n\n"]));
		const received: string[] = [];
		await postSse(request(), (data) => received.push(data), NO_RETRY);
		assert.deepEqual(received, ["前半"]);
	});

	it("响应状态不是成功时抛出，并带上响应体片段", async () => {
		stub(async () => new Response("密钥不对", { status: 401 }));
		await assert.rejects(
			() => postSse(request(), () => undefined, NO_RETRY),
			(error: unknown) => {
				assert.ok(error instanceof LlmHttpError);
				assert.equal(error.status, 401);
				assert.match(error.message, /HTTP 401/);
				assert.match(error.message, /密钥不对/);
				return true;
			},
		);
	});

	it("响应体过长时只保留一段", async () => {
		stub(async () => new Response("x".repeat(5000), { status: 500 }));
		await assert.rejects(
			() => postSse(request(), () => undefined, NO_RETRY),
			(error: unknown) => {
				assert.ok(error instanceof LlmHttpError);
				assert.ok(error.message.length < 2200);
				assert.ok(error.message.endsWith("…"));
				return true;
			},
		);
	});
});

describe("重试", () => {
	it("上游故障时按策略重试，成功即返回", async () => {
		let calls = 0;
		mock.method(globalThis, "fetch", async () => {
			calls += 1;
			if (calls === 1) return new Response("暂时不可用", { status: 503 });
			return sseResponse(["data: 好了\n\n"]);
		});

		const received: string[] = [];
		const retries: number[] = [];
		await postSse(
			request({ onRetry: (attempt: number) => retries.push(attempt) }),
			(data) => received.push(data),
			QUICK_RETRY,
		);

		assert.equal(calls, 2);
		assert.deepEqual(received, ["好了"]);
		assert.deepEqual(retries, [1]);
	});

	it("认证失败不重试：重试多少次结果都一样", async () => {
		let calls = 0;
		mock.method(globalThis, "fetch", async () => {
			calls += 1;
			return new Response("密钥不对", { status: 401 });
		});

		await assert.rejects(() => postSse(request(), () => undefined, QUICK_RETRY));
		assert.equal(calls, 1);
	});

	it("已经推出过事件就不再重试，否则调用方会收到重复内容", async () => {
		let calls = 0;
		stub(async () => {
			calls += 1;
			// 第一条事件之后连接断掉
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: 半句\n\n"));
						controller.error(new Error("连接断了"));
					},
				}),
				{ status: 200 },
			);
		});

		await assert.rejects(() => postSse(request(), () => undefined, QUICK_RETRY), /连接断了/);
		assert.equal(calls, 1);
	});

	it("重试次数用尽后抛出最后一次的错误", async () => {
		let calls = 0;
		mock.method(globalThis, "fetch", async () => {
			calls += 1;
			return new Response("一直不可用", { status: 500 });
		});

		await assert.rejects(() => postSse(request(), () => undefined, QUICK_RETRY), /HTTP 500/);
		assert.equal(calls, 3);
	});
});

describe("请求头检查", () => {
	it("非 ASCII 的头部值给出可读的错误，而不是底层那句难以理解的话", async () => {
		stub(async () => sseResponse(["data: 不该走到这里\n\n"]));
		await assert.rejects(
			() => postSse(request({ headers: { authorization: "Bearer 密钥" } }), () => undefined, NO_RETRY),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /authorization/);
				assert.match(error.message, /apiKey/);
				return true;
			},
		);
		assert.equal(attempts, 0, "应当在校验阶段就被拦下");
	});

	it("latin-1 范围内的头部值照常通过", async () => {
		stub(async () => sseResponse(["data: 通过\n\n"]));
		const received: string[] = [];
		await postSse(
			request({ headers: { "x-custom": "café-1" } }),
			(data) => received.push(data),
			NO_RETRY,
		);
		assert.deepEqual(received, ["通过"]);
	});
});
