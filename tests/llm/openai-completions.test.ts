import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenAiCompletionsAdapter } from '../../src/llm/adapters/openai-completions.ts';
import type { StreamChunk, StreamRequest } from '../../src/llm/types.ts';
import { ReinsError } from '../../src/util/errors.ts';

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const doneFrame = 'data: [DONE]\n\n';

const request: StreamRequest = {
  model: {
    provider: 'demo',
    id: 'demo-model',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1/',
    contextWindow: 128000,
    apiKey: 'secret-key',
  },
  messages: [{ role: 'user', content: '你好' }],
  tools: [{ name: 'read', description: '读取文件', parameters: { type: 'object' } }],
  maxTokens: 2048,
};

async function collect(
  adapter: OpenAiCompletionsAdapter,
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

describe('OpenAI 兼容适配器', () => {
  const adapter = new OpenAiCompletionsAdapter();

  it('解析文本、工具调用、用量与结束原因', async () => {
    const body = [
      sseFrame({ choices: [{ delta: { content: '你好' } }] }),
      sseFrame({ choices: [{ delta: { content: '世界' } }] }),
      sseFrame({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path"' } }],
            },
          },
        ],
      }),
      sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] } }] }),
      sseFrame({
        choices: [{ finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      doneFrame,
    ].join('');

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const chunks = await collect(adapter, fakeFetch);

    assert.equal(capturedUrl, 'https://api.example.com/v1/chat/completions');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer secret-key');
    const sent = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(sent['model'], 'demo-model');
    assert.equal(sent['stream'], true);
    assert.equal(sent['max_tokens'], 2048);
    assert.equal((sent['tools'] as Record<string, unknown>[])[0]?.['type'], 'function');

    const texts = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []));
    assert.deepEqual(texts, ['你好', '世界']);
    const toolCall = chunks.find((chunk) => chunk.type === 'tool_call');
    assert.deepEqual(
      toolCall === undefined ? undefined : (toolCall as { toolCall: unknown }).toolCall,
      { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    );
    const usage = chunks.find((chunk) => chunk.type === 'usage');
    assert.deepEqual(
      usage === undefined ? undefined : (usage as { usage: unknown }).usage,
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: undefined },
    );
    const done = chunks.find((chunk) => chunk.type === 'done');
    assert.equal(
      done === undefined ? undefined : (done as { finishReason: string }).finishReason,
      'tool_calls',
    );
  });

  it('5xx 按 max_retries 重试直至成功', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response('busy', { status: 500 });
      }
      return new Response(
        sseFrame({ choices: [{ delta: { content: 'ok' } }] }) + doneFrame,
        { status: 200 },
      );
    }) as typeof fetch;

    const chunks = await collect(adapter, flaky, 5);
    assert.equal(calls, 3);
    assert.ok(chunks.some((chunk) => chunk.type === 'text' && chunk.text === 'ok'));
  });

  it('4xx 不重试并抛出带状态的错误', async () => {
    let calls = 0;
    const unauthorized = (async () => {
      calls += 1;
      return new Response('bad key', { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      () => collect(adapter, unauthorized, 5),
      (error: unknown) => error instanceof ReinsError && error.message.includes('401'),
    );
    assert.equal(calls, 1);
  });

  it('重试耗尽后抛出可读错误', async () => {
    const alwaysDown = (async () => new Response('down', { status: 503 })) as typeof fetch;
    await assert.rejects(
      () => collect(adapter, alwaysDown, 2),
      (error: unknown) => error instanceof ReinsError && error.message.includes('503'),
    );
  });
});
