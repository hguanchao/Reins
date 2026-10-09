import { ReinsError } from '../../util/errors.ts';
import { resolveProxyDispatcher } from '../proxy.ts';
import { withRetry } from '../retry.ts';
import type { AdapterRuntime } from '../types.ts';

/**
 * 协议适配器共用工具。
 *
 * 设计意图:请求构造、重试与 JSON 容错解析对每个协议都一样,
 * 集中在这里保证行为一致;协议特有的部分留在各自的适配器里。
 */

/** 判断是否为普通对象(排除 null 与数组);协议解析里到处要用。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 JSON 对象;失败或不是对象时返回 undefined(流式解析中静默跳过)。 */
export function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 读取数字;非数字时返回 fallback。 */
export function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

/** 去掉 baseUrl 末尾的斜杠。 */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 构造 POST 初始化参数:JSON body 与代理 dispatcher 透传。 */
export async function buildRequestInit(params: {
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  proxy?: string;
}): Promise<RequestInit> {
  const init: RequestInit & { dispatcher?: unknown } = {
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify(params.body),
    signal: params.signal,
  };
  const dispatcher = await resolveProxyDispatcher(params.proxy);
  if (dispatcher !== undefined) {
    (init as { dispatcher?: unknown }).dispatcher = dispatcher;
  }
  return init;
}

/** 校验流式响应可用并返回响应体;失败时抛可读错误(HTTP 状态与响应体片段)。 */
export async function assertOkStreaming(response: Response): Promise<ReadableStream<Uint8Array>> {
  if (response.ok && response.body !== null) {
    return response.body;
  }
  const detail = await response.text().catch(() => '');
  throw new ReinsError(
    'llm',
    `模型请求失败(HTTP ${response.status})`,
    detail.slice(0, 500) || '请检查 baseUrl、apiKey 与模型名。',
  );
}

/** 带重试的请求:429 与 5xx 可重试;中止不重试,失败抛出可读错误。 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  runtime: AdapterRuntime,
): Promise<Response> {
  const sleep = runtime.sleep ?? defaultSleep;
  try {
    return await withRetry(
      async () => {
        if (init.signal?.aborted) {
          throw abortError();
        }
        const response = await fetchImpl(url, init);
        if (response.status >= 500 || response.status === 429) {
          // 丢弃响应体前先取消,避免连接被一直占用
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`上游返回 HTTP ${response.status}`);
        }
        return response;
      },
      {
        // max_retries 表示首次失败后的重试次数,0 = 失败即停
        attempts: Math.max(1, runtime.maxRetries + 1),
        retriable: (error: unknown) => (error as { name?: string })?.name !== 'AbortError',
        sleep: (ms: number) => sleepWithSignal(ms, init.signal ?? undefined, sleep),
      },
    );
  } catch (error) {
    // 中止不是「请求失败」:原样抛出,让上层按中断处理,而不是包成网络错误
    if ((error as { name?: string })?.name === 'AbortError') {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReinsError('llm', `模型请求失败:${detail}`, '检查网络与 baseUrl,或调大 max_retries。');
  }
}

/** 退避等待,期间若收到中止信号则立即结束(不再空等到退避结束)。 */
async function sleepWithSignal(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const error = new Error('请求已中止');
  error.name = 'AbortError';
  return error;
}
