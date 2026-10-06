import { ReinsError } from '../../util/errors.ts';
import { parseSseStream } from '../../util/sse.ts';
import type {
  AdapterRuntime,
  ChatMessage,
  ProviderAdapter,
  StreamChunk,
  StreamRequest,
  Usage,
} from '../types.ts';
import { buildRequestInit, fetchWithRetry, readNumber, trimBaseUrl, tryParseObject } from './shared.ts';

/**
 * Anthropic Messages 协议适配器(SSE 流式)。
 *
 * 设计意图:协议翻译要点——system 独立成字段、工具调用以 content block 表达、
 * 连续的工具结果需要合并进同一条 user 消息;其余部分与统一流式块一一对应。
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface ToolUseAccumulator {
  id: string;
  name: string;
  json: string;
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly api = 'anthropic-messages';

  async *stream(request: StreamRequest, runtime: AdapterRuntime): AsyncIterable<StreamChunk> {
    const fetchImpl = runtime.fetchImpl ?? fetch;
    const url = `${trimBaseUrl(request.model.baseUrl)}/v1/messages`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(request.model.headers ?? {}),
    };
    if (request.model.apiKey !== undefined) {
      // Anthropic 使用 x-api-key,而不是 Bearer
      headers['x-api-key'] = request.model.apiKey;
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

    const toolUses = new Map<number, ToolUseAccumulator>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let finishReason = '';

    for await (const event of parseSseStream(response.body)) {
      const payload = tryParseObject(event.data);
      if (payload === undefined) {
        continue;
      }
      const type = typeof payload['type'] === 'string' ? (payload['type'] as string) : event.event;
      if (type === 'message_start') {
        const message = payload['message'];
        const usage = isRecord(message) && isRecord(message['usage']) ? message['usage'] : {};
        inputTokens = readNumber(usage['input_tokens']);
        if (typeof usage['cache_read_input_tokens'] === 'number') {
          cacheReadTokens = usage['cache_read_input_tokens'];
        }
        if (typeof usage['cache_creation_input_tokens'] === 'number') {
          cacheWriteTokens = usage['cache_creation_input_tokens'];
        }
        continue;
      }
      if (type === 'content_block_start') {
        const block = payload['content_block'];
        if (isRecord(block) && block['type'] === 'tool_use') {
          const index = readNumber(payload['index']);
          toolUses.set(index, {
            id: typeof block['id'] === 'string' ? block['id'] : '',
            name: typeof block['name'] === 'string' ? block['name'] : '',
            json: '',
          });
        }
        continue;
      }
      if (type === 'content_block_delta') {
        const delta = payload['delta'];
        if (!isRecord(delta)) {
          continue;
        }
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          yield { type: 'text', text: delta['text'] };
          continue;
        }
        if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
          const accumulator = toolUses.get(readNumber(payload['index']));
          if (accumulator !== undefined) {
            accumulator.json += delta['partial_json'];
          }
        }
        continue;
      }
      if (type === 'message_delta') {
        const delta = payload['delta'];
        if (isRecord(delta) && typeof delta['stop_reason'] === 'string') {
          finishReason = delta['stop_reason'];
        }
        const usage = payload['usage'];
        if (isRecord(usage)) {
          outputTokens = readNumber(usage['output_tokens'], outputTokens);
        }
        continue;
      }
      if (type === 'error') {
        const error = payload['error'];
        const message =
          isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '未知错误';
        throw new ReinsError('llm', `模型返回错误:${message}`);
      }
    }

    for (const [index, accumulator] of [...toolUses.entries()].sort((left, right) => left[0] - right[0])) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: accumulator.id !== '' ? accumulator.id : `tool_use_${index}`,
          name: accumulator.name,
          arguments: accumulator.json === '' ? '{}' : accumulator.json,
        },
      };
    }
    const usage: Usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    yield { type: 'usage', usage };
    yield { type: 'done', finishReason: finishReason !== '' ? finishReason : 'end_turn' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildRequestBody(request: StreamRequest): Record<string, unknown> {
  const split = splitSystem(request.messages);
  const body: Record<string, unknown> = {
    model: request.model.id,
    max_tokens: request.maxTokens ?? request.model.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(split.messages),
    stream: true,
  };
  if (split.system !== undefined) {
    body['system'] = split.system;
  }
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (request.temperature !== undefined) {
    body['temperature'] = request.temperature;
  }
  return body;
}

function splitSystem(messages: ChatMessage[]): { system?: string; messages: ChatMessage[] } {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
    } else {
      rest.push(message);
    }
  }
  if (systemParts.length === 0) {
    return { messages: rest };
  }
  return { system: systemParts.join('\n\n'), messages: rest };
}

function toAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (message.content !== '') {
        blocks.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: tryParseObject(call.arguments) ?? {},
        });
      }
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // 工具结果:必须放在 user 消息中;连续结果合并进同一条消息
    const toolResult = {
      type: 'tool_result',
      tool_use_id: message.toolCallId ?? '',
      content: message.content,
    };
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last['role'] === 'user' &&
      Array.isArray(last['content']) &&
      isRecord((last['content'] as unknown[])[0]) &&
      ((last['content'] as Record<string, unknown>[])[0] as Record<string, unknown>)['type'] ===
        'tool_result'
    ) {
      (last['content'] as unknown[]).push(toolResult);
    } else {
      out.push({ role: 'user', content: [toolResult] });
    }
  }
  return out;
}
