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

/** 指数退避。第一次重试等 baseDelayMs，之后翻倍。 */
export function backoffDelay(attempt: number, baseDelayMs: number): number {
	return Math.min(baseDelayMs * 2 ** attempt, MAX_DELAY_MS);
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
