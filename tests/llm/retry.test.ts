import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backoffDelay, DEFAULT_RETRY_BASE_DELAY_MS, delay, isRetryableStatus } from "../../src/llm/retry.ts";

describe("重试策略", () => {
	it("值得重试的状态码:限流与上游故障,不包括认证与参数", () => {
		assert.equal(isRetryableStatus(408), true);
		assert.equal(isRetryableStatus(409), true);
		assert.equal(isRetryableStatus(429), true);
		assert.equal(isRetryableStatus(500), true);
		assert.equal(isRetryableStatus(503), true);
		assert.equal(isRetryableStatus(401), false);
		assert.equal(isRetryableStatus(403), false);
		assert.equal(isRetryableStatus(400), false);
		assert.equal(isRetryableStatus(404), false);
	});

	it("指数退避:翻倍且单次封顶", () => {
		assert.equal(backoffDelay(0, 2000), 2000);
		assert.equal(backoffDelay(1, 2000), 4000);
		assert.equal(backoffDelay(3, 2000), 16000);
		assert.equal(backoffDelay(6, 2000), 60000); // 128s 被 60s 封顶
		assert.equal(DEFAULT_RETRY_BASE_DELAY_MS, 2000);
	});

	it("delay:中止时立即结束", async () => {
		const controller = new AbortController();
		const pending = delay(10_000, controller.signal);
		controller.abort();
		await assert.rejects(() => pending, /Aborted/);
	});

	it("delay:已中止的信号直接拒绝", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(() => delay(1000, controller.signal), /Aborted/);
	});

	it("delay:未被中止时在超时前返回", async () => {
		await delay(1, new AbortController().signal); // 不卡
	});
});
