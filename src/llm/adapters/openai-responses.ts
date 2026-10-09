import { ReinsError } from '../../util/errors.ts';
import { parseSseStream } from '../../util/sse.ts';
import type {
  AdapterRuntime,
  ProviderAdapter,
  StreamChunk,
  StreamRequest,
  Usage,
} from '../types.ts';
import { assertOkStreaming, buildRequestInit, fetchWithRetry, isRecord, readNumber, trimBaseUrl, tryParseObject } from './shared.ts';

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
    const body = await assertOkStreaming(response);

    const calls = new Map<string, FunctionCallAccumulator>();
    let usage: Usage | undefined;
    let textDeltaSeen = false;
    let finishReason = 'stop';

    /** 登记或补全一个函数调用;只填空参数,避免与已累积的分片重复拼接。 */
    const upsertFunctionCall = (item: Record<string, unknown>): void => {
      const itemId = typeof item['id'] === 'string' ? item['id'] : '';
      const callId = typeof item['call_id'] === 'string' ? item['call_id'] : '';
      const key = itemId !== '' ? itemId : callId;
      if (key === '') {
        return;
      }
      const args = typeof item['arguments'] === 'string' ? item['arguments'] : '';
      const existing = calls.get(key);
      if (existing === undefined) {
        calls.set(key, {
          callId,
          name: typeof item['name'] === 'string' ? item['name'] : '',
          arguments: args,
        });
        return;
      }
      if (existing.arguments === '' && args !== '') {
        existing.arguments = args;
      }
      if (existing.name === '' && typeof item['name'] === 'string') {
        existing.name = item['name'];
      }
      if (existing.callId === '' && callId !== '') {
        existing.callId = callId;
      }
    };

    for await (const event of parseSseStream(body)) {
      if (event.data.trim() === '[DONE]') {
        break;
      }
      const payload = tryParseObject(event.data);
      if (payload === undefined) {
        continue;
      }
      const type = typeof payload['type'] === 'string' ? payload['type'] : undefined;
      if (type === 'response.output_text.delta') {
        if (typeof payload['delta'] === 'string' && payload['delta'] !== '') {
          textDeltaSeen = true;
          yield { type: 'text', text: payload['delta'] };
        }
        continue;
      }
      if (type === 'response.output_text.done') {
        // 只在完全没有收到增量时兜底,否则会与已产出的文本重复
        if (!textDeltaSeen && typeof payload['text'] === 'string' && payload['text'] !== '') {
          textDeltaSeen = true;
          yield { type: 'text', text: payload['text'] };
        }
        continue;
      }
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        // done 事件携带的是完整 item:端点只发 done 时,参数必须从这里补齐
        const item = payload['item'];
        if (isRecord(item) && item['type'] === 'function_call') {
          upsertFunctionCall(item);
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
      if (type === 'response.completed' || type === 'response.incomplete') {
        const completed = payload['response'];
        if (isRecord(completed)) {
          const rawUsage = completed['usage'];
          if (isRecord(rawUsage)) {
            usage = mapUsage(rawUsage);
          }
          // 有的端点只在完成事件里给完整输出、不逐条发增量;
          // 漏掉这段会静默丢掉正文与工具调用,代理误以为模型正常结束而停轮
          const output = completed['output'];
          if (Array.isArray(output)) {
            if (!textDeltaSeen) {
              const text = collectOutputText(output);
              if (text !== '') {
                textDeltaSeen = true;
                yield { type: 'text', text };
              }
            }
            for (const item of output) {
              if (isRecord(item) && item['type'] === 'function_call') {
                upsertFunctionCall(item);
              }
            }
          }
          // incomplete 事件同样表示被截断,不能停在 'stop'
          if (type === 'response.incomplete' || completed['status'] === 'incomplete') {
            finishReason = 'length';
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
    yield { type: 'done', finishReason };
  }
}

/** 从 completed.output 的 message 项里拼出正文;仅用于未收到任何文本增量时的兜底。 */
function collectOutputText(output: readonly unknown[]): string {
  let text = '';
  for (const item of output) {
    if (!isRecord(item) || item['type'] !== 'message') {
      continue;
    }
    const content = item['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (isRecord(part) && typeof part['text'] === 'string') {
        text += part['text'];
      }
    }
  }
  return text;
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
