import { ReinsError } from '../../util/errors.ts';
import { parseSseStream } from '../../util/sse.ts';
import type {
  AdapterRuntime,
  ProviderAdapter,
  StreamChunk,
  StreamRequest,
  Usage,
} from '../types.ts';
import { buildRequestInit, fetchWithRetry, readNumber, trimBaseUrl, tryParseObject } from './shared.ts';

/**
 * Google Generative AI(Gemini)协议适配器(SSE 流式)。
 *
 * 设计意图:请求侧把消息翻译为 contents(system 独立为 systemInstruction,
 * 工具结果用 functionResponse 表达);响应侧每个候选块里增量拼接文本与函数调用。
 * 该协议不携带调用 id,这里按出现顺序生成稳定编号。
 */

export class GoogleGenerativeAiAdapter implements ProviderAdapter {
  readonly api = 'google-generative-ai';

  async *stream(request: StreamRequest, runtime: AdapterRuntime): AsyncIterable<StreamChunk> {
    const fetchImpl = runtime.fetchImpl ?? fetch;
    const url = `${trimBaseUrl(request.model.baseUrl)}/v1beta/models/${encodeURIComponent(
      request.model.id,
    )}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(request.model.headers ?? {}),
    };
    if (request.model.apiKey !== undefined) {
      headers['x-goog-api-key'] = request.model.apiKey;
    }
    const init = await buildRequestInit({
      headers,
      body: buildRequestBody(request),
      signal: request.signal,
      proxy: runtime.proxy,
    });
    const response = await fetchWithRetry(fetchImpl, url, init, runtime);

    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '');
      throw new ReinsError(
        'llm',
        `模型请求失败(HTTP ${response.status})`,
        detail.slice(0, 500) || '请检查 baseUrl、apiKey 与模型名。',
      );
    }

    let callIndex = 0;
    let usage: Usage | undefined;
    let finishReason = '';
    // 上一个事件里已发出的调用签名:流式分片可能把同一个 functionCall 重发一次,
    // 不去重会当成两次调用执行,对有副作用的工具即重复写入/重复执行。
    // 只在事件之间比对,同一事件内的两次相同调用是合法的,照常发出。
    let previousSignatures = new Set<string>();

    for await (const event of parseSseStream(response.body)) {
      if (event.data === '[DONE]') {
        break;
      }
      const payload = tryParseObject(event.data);
      if (payload === undefined) {
        continue;
      }
      const rawUsage = payload['usageMetadata'];
      if (isRecord(rawUsage)) {
        usage = mapUsage(rawUsage);
      }
      const candidates = payload['candidates'];
      if (!Array.isArray(candidates) || candidates.length === 0) {
        continue;
      }
      const candidate = candidates[0];
      if (!isRecord(candidate)) {
        continue;
      }
      const content = candidate['content'];
      const currentSignatures = new Set<string>();
      if (isRecord(content)) {
        const parts = content['parts'];
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (!isRecord(part)) {
              continue;
            }
            if (typeof part['text'] === 'string' && part['text'] !== '') {
              yield { type: 'text', text: part['text'] };
            }
            const call = part['functionCall'];
            if (isRecord(call) && typeof call['name'] === 'string') {
              const signature = `${call['name']}\u0000${JSON.stringify(call['args'] ?? {})}`;
              if (previousSignatures.has(signature)) {
                continue;
              }
              currentSignatures.add(signature);
              callIndex += 1;
              yield {
                type: 'tool_call',
                toolCall: {
                  id: `call_${callIndex}`,
                  name: call['name'],
                  arguments: JSON.stringify(call['args'] ?? {}),
                },
              };
            }
          }
        }
      }
      previousSignatures = currentSignatures;
      if (typeof candidate['finishReason'] === 'string') {
        finishReason = mapFinishReason(candidate['finishReason']);
      }
    }

    if (usage !== undefined) {
      yield { type: 'usage', usage };
    }
    yield { type: 'done', finishReason: finishReason !== '' ? finishReason : 'stop' };
  }
}

function buildRequestBody(request: StreamRequest): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];
  const systemParts: string[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (message.content !== '') {
        parts.push({ text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            name: call.name,
            args: tryParseObject(call.arguments) ?? {},
          },
        });
      }
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: message.name ?? 'unknown',
            response: { result: message.content },
          },
        },
      ],
    });
  }

  const body: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    body['systemInstruction'] = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  if (request.tools.length > 0) {
    body['tools'] = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }
  const generationConfig: Record<string, unknown> = {};
  const maxTokens = request.maxTokens ?? request.model.maxTokens;
  if (maxTokens !== undefined) {
    generationConfig['maxOutputTokens'] = maxTokens;
  }
  if (request.temperature !== undefined) {
    generationConfig['temperature'] = request.temperature;
  }
  if (Object.keys(generationConfig).length > 0) {
    body['generationConfig'] = generationConfig;
  }
  return body;
}

function mapFinishReason(raw: string): string {
  if (raw === 'STOP') {
    return 'stop';
  }
  if (raw === 'MAX_TOKENS') {
    return 'length';
  }
  return raw.toLowerCase();
}

function mapUsage(raw: Record<string, unknown>): Usage {
  const cached = raw['cachedContentTokenCount'];
  return {
    inputTokens: readNumber(raw['promptTokenCount']),
    outputTokens: readNumber(raw['candidatesTokenCount']),
    cacheReadTokens: typeof cached === 'number' ? cached : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
