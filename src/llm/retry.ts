/**
 * 重试工具:指数退避,等待与判定均可注入,便于测试。
 */

export interface RetryOptions {
  /** 总尝试次数(含首次)。 */
  attempts: number;
  /** 是否可重试;默认全部可重试。 */
  retriable?: (error: unknown) => boolean;
  /** 第 N 次失败后的等待毫秒数;默认指数退避。 */
  delayMs?: (attempt: number) => number;
  /** 等待实现;默认真实计时,测试可注入空实现。 */
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  const retriable = options.retriable ?? (() => true);
  const delayMs = options.delayMs ?? ((attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8000));
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retriable(error)) {
        break;
      }
      await sleep(delayMs(attempt));
    }
  }
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
