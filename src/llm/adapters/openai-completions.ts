import { ReinsError } from '../../util/errors.ts';
import { parseSseStream } from '../../util/sse.ts';
import { buildRequestInit, fetchWithRetry, trimBaseUrl, tryParseObject } from './shared.ts';
import type {
  AdapterRuntime,
  ChatMessage,
  ProviderAdapter,
  StreamChunk,
  StreamRequest,
  Usage,
} from '../types.ts';

/**
 * OpenAI 兼容协议适配器(chat/completions + SSE 流式)。
 *
 * 设计意图:一条适配器覆盖所有 OpenAI 兼容端点;
 * 只做协议翻译与归一化,不包含任何端点知识。
 */

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAiCompletionsAdapter implements ProviderAdapter {
  readonly api = 'openai-completions';

  async *stream(request: StreamRequest, runtime: AdapterRuntime): AsyncIterable<StreamChunk> {
    const fetchImpl = runtime.fetchImpl ?? fetch;
    const url = `${trimBaseUrl(request.model.baseUrl)}/chat/completions`;
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

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason = '';
    let usage: Usage | undefined;

    for await (const event of parseSseStream(response.body)) {
      if (event.data === '[DONE]') {
        break;
      }
      const payload = tryParseObject(event.data);
      if (payload === undefined) {
        continue;
      }
      const rawUsage = payload['usage'];
      if (rawUsage !== undefined && rawUsage !== null) {
        usage = mapUsage(rawUsage as Record<string, unknown>);
      }
      const choices = payload['choices'];
      if (!Array.isArray(choices) || choices.length === 0) {
        continue;
      }
      const choice = choices[0] as Record<string, unknown>;
      const delta = choice['delta'];
      if (delta !== undefined && delta !== null) {
        yield* handleDelta(delta as Record<string, unknown>, toolCalls);
      }
      const reason = choice['finish_reason'];
      if (typeof reason === 'string' && reason !== '') {
        finishReason = reason;
      }
    }

    const ordered = [...toolCalls.entries()].sort((left, right) => left[0] - right[0]);
    for (const [index, acc] of ordered) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: acc.id !== '' ? acc.id : `call_${index}`,
          name: acc.name,
          arguments: acc.arguments === '' ? '{}' : acc.arguments,
        },
      };
    }
    if (usage !== undefined) {
      yield { type: 'usage', usage };
    }
    yield { type: 'done', finishReason: finishReason !== '' ? finishReason : 'stop' };
  }
}

function* handleDelta(
  delta: Record<string, unknown>,
  toolCalls: Map<number, ToolCallAccumulator>,
): Generator<StreamChunk> {
  const content = delta['content'];
  if (typeof content === 'string' && content !== '') {
    yield { type: 'text', text: content };
  }
  const rawCalls = delta['tool_calls'];
  if (!Array.isArray(rawCalls)) {
    return;
  }
  for (const item of rawCalls) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const index = typeof record['index'] === 'number' ? record['index'] : 0;
    const acc = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
    if (typeof record['id'] === 'string') {
      acc.id = record['id'];
    }
    const fn = record['function'];
    if (typeof fn === 'object' && fn !== null) {
      const fnRecord = fn as Record<string, unknown>;
      if (typeof fnRecord['name'] === 'string') {
        acc.name = fnRecord['name'];
      }
      if (typeof fnRecord['arguments'] === 'string') {
        acc.arguments += fnRecord['arguments'];
      }
    }
    toolCalls.set(index, acc);
  }
}

function buildRequestBody(request: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: request.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  const maxTokens = request.maxTokens ?? request.model.maxTokens;
  if (maxTokens !== undefined) {
    body['max_tokens'] = maxTokens;
  }
  if (request.temperature !== undefined) {
    body['temperature'] = request.temperature;
  }
  if (request.reasoningEffort !== undefined && request.reasoningEffort !== 'off') {
    body['reasoning_effort'] = request.reasoningEffort;
  }
  return body;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content,
    };
  }
  if (message.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: message.content };
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      wire['tool_calls'] = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return wire;
  }
  return { role: message.role, content: message.content };
}

function mapUsage(raw: Record<string, unknown>): Usage {
  const number = (value: unknown): number => (typeof value === 'number' ? value : 0);
  const details = (raw['prompt_tokens_details'] ?? {}) as Record<string, unknown>;
  const cached = details['cached_tokens'];
  return {
    inputTokens: number(raw['prompt_tokens']),
    outputTokens: number(raw['completion_tokens']),
    cacheReadTokens: typeof cached === 'number' ? cached : undefined,
  };
}
