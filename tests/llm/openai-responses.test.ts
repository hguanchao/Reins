import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenAiResponsesAdapter } from '../../src/llm/adapters/openai-responses.ts';
import type { StreamChunk, StreamRequest } from '../../src/llm/types.ts';
import { ReinsError } from '../../src/util/errors.ts';

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const request: StreamRequest = {
  model: {
    provider: 'demo',
    id: 'gpt-demo',
    api: 'openai-responses',
    baseUrl: 'https://api.example.com/v1/',
    contextWindow: 128000,
    apiKey: 'sk-test',
  },
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"a.txt"}' }],
    },
    { role: 'tool', toolCallId: 't1', name: 'read', content: '文件内容' },
  ],
  tools: [{ name: 'read', description: '读取', parameters: { type: 'object' } }],
  maxTokens: 2048,
};

async function collect(
  adapter: OpenAiResponsesAdapter,
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

describe('OpenAI Responses 适配器', () => {
  const adapter = new OpenAiResponsesAdapter();

  it('解析文本、函数调用、用量,并正确编码 input 项', async () => {
    const body =
      frame({
        type: 'response.output_item.added',
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '' },
      }) +
      frame({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"path"',
      }) +
      frame({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: ':"a.txt"}',
      }) +
      frame({ type: 'response.output_text.delta', delta: '你好' }) +
      frame({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 2 },
          },
        },
      });

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const chunks = await collect(adapter, fakeFetch);

    assert.equal(capturedUrl, 'https://api.example.com/v1/responses');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer sk-test');
    const sent = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(sent['model'], 'gpt-demo');
    assert.equal(sent['instructions'], 'SYS');
    assert.equal(sent['max_output_tokens'], 2048);
    const input = sent['input'] as Record<string, unknown>[];
    assert.equal(input.length, 3);
    assert.equal(input[1]?.['type'], 'function_call');
    assert.equal(input[2]?.['type'], 'function_call_output');
    assert.equal(input[2]?.['call_id'], 't1');
    assert.equal((sent['tools'] as Record<string, unknown>[])[0]?.['name'], 'read');

    const texts = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []));
    assert.deepEqual(texts, ['你好']);
    const toolCall = chunks.find((chunk) => chunk.type === 'tool_call');
    assert.deepEqual(
      toolCall === undefined ? undefined : (toolCall as { toolCall: unknown }).toolCall,
      { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    );
    const usage = chunks.find((chunk) => chunk.type === 'usage');
    assert.deepEqual(
      usage === undefined ? undefined : (usage as { usage: unknown }).usage,
      { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2 },
    );
  });

  it('只在完成事件里给出输出时,正文与函数调用都不丢', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_2',
      call_id: 'call_2',
      name: 'bash',
      arguments: '{"command":"ls"}',
    };
    const body =
      frame({ type: 'response.output_item.done', item }) +
      frame({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }, item],
        },
      });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;

    const chunks = await collect(adapter, fakeFetch);

    const texts = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []));
    assert.deepEqual(texts, ['hi']);
    const toolCalls = chunks.flatMap((chunk) => (chunk.type === 'tool_call' ? [chunk.toolCall] : []));
    // done 与 completed 携带同一 item,参数只补一次,不能重复发出
    assert.deepEqual(toolCalls, [{ id: 'call_2', name: 'bash', arguments: '{"command":"ls"}' }]);
  });

  it('failed 事件转为可读错误', async () => {
    const body = frame({ type: 'response.failed', error: { message: 'rate limited' } });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    await assert.rejects(
      () => collect(adapter, fakeFetch),
      (error: unknown) => error instanceof ReinsError && error.message.includes('rate limited'),
    );
  });

  it('response.incomplete 视为长度截断,且仍取出正文与函数调用', async () => {
    const body =
      frame({ type: 'response.output_text.delta', delta: '半句' }) +
      frame({
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: '半句' }] },
            { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'read', arguments: '{"path":"a"}' },
          ],
        },
      });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const chunks = await collect(adapter, fakeFetch);
    const done = chunks.find((chunk) => chunk.type === 'done');
    assert.equal(
      done === undefined ? undefined : (done as { finishReason: string }).finishReason,
      'length',
    );
    const toolCalls = chunks.flatMap((chunk) => (chunk.type === 'tool_call' ? [chunk.toolCall] : []));
    assert.deepEqual(toolCalls, [{ id: 'call_9', name: 'read', arguments: '{"path":"a"}' }]);
  });
});
