/** 重试策略。取值来自 config.toml 的 max_retries。 */
export interface RetryPolicy {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
}

/** 单次等待的上限，避免退避到让人以为程序卡死。 */
const MAX_DELAY_MS = 60_000;

/**
 * 值得重试的响应码。
 *
 * 只覆盖「再试一次可能就好了」的情形：限流与上游故障。认证失败、参数写错、地址不对重试
 * 多少次结果都一样，把它们也重试只会推迟给出错误信息的时间。
 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

/** 指数退避加抖动。抖动让多个同时失败的实例不会在同一个瞬间一起回来。 */
export function backoffDelay(attempt: number, baseDelayMs: number): number {
	const base = Math.min(baseDelayMs * 2 ** attempt, MAX_DELAY_MS);
	return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 等多久再试下一次。
 *
 * 服务端说了算：`Retry-After` 是它对「多久之后再来」给出的明确要求，比我们自己猜的退避更
 * 准。要求等得比上限还久时不硬等——那多半是配额级别的限流，等下去只会让人以为程序卡住；
 * 直接把情况报出来。
 */
export function retryDelay(
	attempt: number,
	policy: RetryPolicy,
	retryAfterMs: number | undefined,
): number {
	if (retryAfterMs === undefined) return backoffDelay(attempt, policy.baseDelayMs);
	if (retryAfterMs > MAX_DELAY_MS) {
		throw new Error(
			`the upstream asked to retry in ${Math.round(retryAfterMs / 1000)}s, longer than the ${MAX_DELAY_MS / 1000}s limit`,
		);
	}
	return retryAfterMs;
}

/** 可被中止的等待。中止时立即结束，让上层把结果标成 aborted。 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** 退避的起始间隔。config.toml 里只有重试次数，间隔按一个不会让人以为卡死的值取。 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
