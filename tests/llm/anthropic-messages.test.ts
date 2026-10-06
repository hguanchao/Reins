import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnthropicMessagesAdapter } from '../../src/llm/adapters/anthropic-messages.ts';
import type { StreamChunk, StreamRequest } from '../../src/llm/types.ts';
import { ReinsError } from '../../src/util/errors.ts';

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const request: StreamRequest = {
  model: {
    provider: 'demo',
    id: 'claude-demo',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/',
    contextWindow: 200000,
    apiKey: 'ak',
  },
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 't1', name: 'read', arguments: '{"path":"a.txt"}' },
        { id: 't2', name: 'read', arguments: '{"path":"b.txt"}' },
      ],
    },
    { role: 'tool', toolCallId: 't1', content: 'A 内容' },
    { role: 'tool', toolCallId: 't2', content: 'B 内容' },
  ],
  tools: [{ name: 'read', description: '读取', parameters: { type: 'object' } }],
  maxTokens: 2048,
};

async function collect(
  adapter: AnthropicMessagesAdapter,
  fetchImpl: typeof fetch,
  maxRetries = 0,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(request, {
    maxRetries,
    fetchImpl,
    sleep: async () => {},
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('Anthropic Messages 适配器', () => {
  const adapter = new AnthropicMessagesAdapter();

  it('解析文本、工具调用、用量与结束原因,并正确编码请求', async () => {
    const body =
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
      }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你好' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"a.txt"}' },
      }) +
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7 },
      }) +
      frame('message_stop', { type: 'message_stop' });

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const chunks = await collect(adapter, fakeFetch);

    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'ak');
    assert.equal(headers['anthropic-version'], '2023-06-01');

    const sent = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(sent['model'], 'claude-demo');
    assert.equal(sent['max_tokens'], 2048);
    assert.equal(sent['system'], 'SYS');
    const messages = sent['messages'] as Record<string, unknown>[];
    assert.equal(messages.length, 3);
    assert.deepEqual(
      (messages[2]?.['content'] as Record<string, unknown>[]).map((block) => block['type']),
      ['tool_result', 'tool_result'],
    );
    const tools = sent['tools'] as Record<string, unknown>[];
    assert.deepEqual(tools[0]?.['input_schema'], { type: 'object' });

    const texts = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []));
    assert.deepEqual(texts, ['你好']);
    const toolCall = chunks.find((chunk) => chunk.type === 'tool_call');
    assert.deepEqual(
      toolCall === undefined ? undefined : (toolCall as { toolCall: unknown }).toolCall,
      { id: 'toolu_1', name: 'read', arguments: '{"path":"a.txt"}' },
    );
    const usage = chunks.find((chunk) => chunk.type === 'usage');
    assert.deepEqual(
      usage === undefined ? undefined : (usage as { usage: unknown }).usage,
      { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: undefined },
    );
    const done = chunks.find((chunk) => chunk.type === 'done');
    assert.equal(
      done === undefined ? undefined : (done as { finishReason: string }).finishReason,
      'tool_use',
    );
  });

  it('error 事件转为可读错误', async () => {
    const body = frame('error', { type: 'error', error: { message: 'overloaded_error' } });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    await assert.rejects(
      () => collect(adapter, fakeFetch),
      (error: unknown) => error instanceof ReinsError && error.message.includes('overloaded_error'),
    );
  });

  it('5xx 按 max_retries 重试直至成功', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls < 2) {
        return new Response('busy', { status: 500 });
      }
      return new Response(
        frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }) +
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          }),
        { status: 200 },
      );
    }) as typeof fetch;

    const chunks = await collect(adapter, flaky, 3);
    assert.equal(calls, 2);
    const done = chunks.find((chunk) => chunk.type === 'done');
    assert.equal(
      done === undefined ? undefined : (done as { finishReason: string }).finishReason,
      'end_turn',
    );
  });
});
