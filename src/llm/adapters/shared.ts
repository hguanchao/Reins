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

/** 解析 JSON 对象;失败或不是对象时返回 undefined(流式解析中静默跳过)。 */
export function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
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

/** 带重试的请求:429 与 5xx 可重试;失败抛出可读错误。 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  runtime: AdapterRuntime,
): Promise<Response> {
  try {
    return await withRetry(
      async () => {
        const response = await fetchImpl(url, init);
        if (response.status >= 500 || response.status === 429) {
          throw new Error(`上游返回 HTTP ${response.status}`);
        }
        return response;
      },
      {
        // max_retries 表示首次失败后的重试次数,0 = 失败即停
        attempts: Math.max(1, runtime.maxRetries + 1),
        retriable: (error: unknown) => (error as { name?: string })?.name !== 'AbortError',
        sleep: runtime.sleep,
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReinsError('llm', `模型请求失败:${detail}`, '检查网络与 baseUrl,或调大 max_retries。');
  }
}
