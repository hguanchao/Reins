import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backoffDelay, DEFAULT_RETRY_BASE_DELAY_MS, delay, isRetryableStatus, retryDelay } from "../../src/llm/retry.ts";

/** 抖动后的取值应当在基准的 ±20% 之内。 */
function withinJitter(value: number, base: number): boolean {
	return value >= Math.round(base * 0.8) - 1 && value <= Math.round(base * 1.2) + 1;
}

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

	it("指数退避:翻倍、带抖动、单次封顶", () => {
		// 多次取样：抖动是随机的，只断言落点范围
		for (let sample = 0; sample < 20; sample += 1) {
			assert.ok(withinJitter(backoffDelay(0, 2000), 2000));
			assert.ok(withinJitter(backoffDelay(1, 2000), 4000));
			assert.ok(withinJitter(backoffDelay(3, 2000), 16000));
			// 128s 被 60s 封顶，抖动只在封顶值上下浮动
			assert.ok(withinJitter(backoffDelay(6, 2000), 60000));
		}
		assert.equal(DEFAULT_RETRY_BASE_DELAY_MS, 2000);
	});

	it("服务端给了 Retry-After 就按它等", () => {
		assert.equal(retryDelay(0, { maxRetries: 3, baseDelayMs: 2000 }, 5000), 5000);
		// 退避到哪一次都不影响：服务端说了算
		assert.equal(retryDelay(5, { maxRetries: 9, baseDelayMs: 2000 }, 1000), 1000);
	});

	it("Retry-After 超过能接受的上限时直接报出来，不硬等", () => {
		assert.throws(
			() => retryDelay(0, { maxRetries: 3, baseDelayMs: 2000 }, 120_000),
			/asked to retry in 120s/,
		);
	});

	it("没有 Retry-After 时用退避", () => {
		assert.ok(withinJitter(retryDelay(0, { maxRetries: 3, baseDelayMs: 2000 }, undefined), 2000));
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
