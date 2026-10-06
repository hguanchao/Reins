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
 * OpenAI Responses 协议适配器(SSE 流式)。
 *
 * 设计意图:请求侧把消息序列翻译为 input 项序列——system 独立为 instructions,
 * 工具调用与结果作为顶层 item 表达;响应侧按事件类型累积文本与函数调用参数。
 */

interface FunctionCallAccumulator {
  callId: string;
  name: string;
  arguments: string;
}

export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly api = 'openai-responses';

  async *stream(request: StreamRequest, runtime: AdapterRuntime): AsyncIterable<StreamChunk> {
    const fetchImpl = runtime.fetchImpl ?? fetch;
    const url = `${trimBaseUrl(request.model.baseUrl)}/responses`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(request.model.headers ?? {}),
    };
    if (request.model.apiKey !== undefined) {
      headers['authorization'] = `Bearer ${request.model.apiKey}`;
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

    const calls = new Map<string, FunctionCallAccumulator>();
    let usage: Usage | undefined;

    for await (const event of parseSseStream(response.body)) {
      if (event.data === '[DONE]') {
        break;
      }
      const payload = tryParseObject(event.data);
      if (payload === undefined) {
        continue;
      }
      const type = typeof payload['type'] === 'string' ? payload['type'] : undefined;
      if (type === 'response.output_text.delta') {
        if (typeof payload['delta'] === 'string' && payload['delta'] !== '') {
          yield { type: 'text', text: payload['delta'] };
        }
        continue;
      }
      if (type === 'response.output_item.added') {
        const item = payload['item'];
        if (isRecord(item) && item['type'] === 'function_call') {
          const itemId = typeof item['id'] === 'string' ? item['id'] : '';
          calls.set(itemId, {
            callId: typeof item['call_id'] === 'string' ? item['call_id'] : '',
            name: typeof item['name'] === 'string' ? item['name'] : '',
            arguments: '',
          });
        }
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const itemId = typeof payload['item_id'] === 'string' ? payload['item_id'] : '';
        const accumulator = calls.get(itemId);
        if (accumulator !== undefined && typeof payload['delta'] === 'string') {
          accumulator.arguments += payload['delta'];
        }
        continue;
      }
      if (type === 'response.completed') {
        const completed = payload['response'];
        if (isRecord(completed)) {
          const rawUsage = completed['usage'];
          if (isRecord(rawUsage)) {
            usage = mapUsage(rawUsage);
          }
        }
        continue;
      }
      if (type === 'response.failed' || type === 'error') {
        const error = payload['error'];
        const message =
          isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '未知错误';
        throw new ReinsError('llm', `模型返回错误:${message}`);
      }
    }

    let fallback = 0;
    for (const accumulator of calls.values()) {
      fallback += 1;
      yield {
        type: 'tool_call',
        toolCall: {
          id: accumulator.callId !== '' ? accumulator.callId : `call_${fallback}`,
          name: accumulator.name,
          arguments: accumulator.arguments === '' ? '{}' : accumulator.arguments,
        },
      };
    }
    if (usage !== undefined) {
      yield { type: 'usage', usage };
    }
    yield { type: 'done', finishReason: 'stop' };
  }
}

function buildRequestBody(request: StreamRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  const systemParts: string[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content !== '') {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    input.push({
      type: 'function_call_output',
      call_id: message.toolCallId ?? '',
      output: message.content,
    });
  }

  const body: Record<string, unknown> = { model: request.model.id, input, stream: true, store: false };
  if (systemParts.length > 0) {
    body['instructions'] = systemParts.join('\n\n');
  }
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  const maxTokens = request.maxTokens ?? request.model.maxTokens;
  if (maxTokens !== undefined) {
    body['max_output_tokens'] = maxTokens;
  }
  if (request.temperature !== undefined) {
    body['temperature'] = request.temperature;
  }
  return body;
}

function mapUsage(raw: Record<string, unknown>): Usage {
  const details = raw['input_tokens_details'];
  const cached = isRecord(details) ? details['cached_tokens'] : undefined;
  return {
    inputTokens: readNumber(raw['input_tokens']),
    outputTokens: readNumber(raw['output_tokens']),
    cacheReadTokens: typeof cached === 'number' ? cached : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
