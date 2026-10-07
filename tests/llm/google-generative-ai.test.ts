import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GoogleGenerativeAiAdapter } from '../../src/llm/adapters/google-generative-ai.ts';
import type { StreamChunk, StreamRequest } from '../../src/llm/types.ts';

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const request: StreamRequest = {
  model: {
    provider: 'demo',
    id: 'gemini-demo',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/',
    contextWindow: 1000000,
    apiKey: 'gk-test',
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
  adapter: GoogleGenerativeAiAdapter,
  fetchImpl: typeof fetch,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(request, {
    maxRetries: 0,
    fetchImpl,
    sleep: async () => {},
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('Google Generative AI 适配器', () => {
  const adapter = new GoogleGenerativeAiAdapter();

  it('解析文本、函数调用、用量,并正确编码 contents', async () => {
    const body =
      frame({ candidates: [{ content: { parts: [{ text: '你好' }] } }] }) +
      frame({
        candidates: [
          { content: { parts: [{ functionCall: { name: 'read', args: { path: 'a.txt' } } }] } },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }) +
      frame({
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      });

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const chunks = await collect(adapter, fakeFetch);

    assert.equal(
      capturedUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-demo:streamGenerateContent?alt=sse',
    );
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'gk-test');
    const sent = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.deepEqual(sent['systemInstruction'], { parts: [{ text: 'SYS' }] });
    const contents = sent['contents'] as Record<string, unknown>[];
    assert.equal(contents.length, 3);
    assert.equal(contents[0]?.['role'], 'user');
    assert.equal(contents[1]?.['role'], 'model');
    const toolParts = contents[1]?.['parts'] as Record<string, unknown>[];
    assert.deepEqual(toolParts[0]?.['functionCall'], { name: 'read', args: { path: 'a.txt' } });
    const responseParts = contents[2]?.['parts'] as Record<string, unknown>[];
    assert.deepEqual(responseParts[0]?.['functionResponse'], {
      name: 'read',
      response: { result: '文件内容' },
    });
    const generationConfig = sent['generationConfig'] as Record<string, unknown>;
    assert.equal(generationConfig['maxOutputTokens'], 2048);

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
      { inputTokens: 5, outputTokens: 3, cacheReadTokens: undefined },
    );
    const done = chunks.find((chunk) => chunk.type === 'done');
    assert.equal(
      done === undefined ? undefined : (done as { finishReason: string }).finishReason,
      'stop',
    );
  });

  it('同一函数调用跨分片重发时只发出一次', async () => {
    const call = { functionCall: { name: 'write', args: { path: 'a.txt', content: 'x' } } };
    const body =
      frame({ candidates: [{ content: { parts: [call] } }] }) +
      frame({ candidates: [{ content: { parts: [call] } }] }) +
      frame({ candidates: [{ finishReason: 'STOP' }] });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const chunks = await collect(adapter, fakeFetch);
    assert.equal(
      chunks.filter((chunk) => chunk.type === 'tool_call').length,
      1,
      '重复的 functionCall 不应被当成两次调用',
    );
  });

  it('同一事件内的两次相同调用仍然都发出', async () => {
    const call = { functionCall: { name: 'read', args: { path: 'a.txt' } } };
    const body =
      frame({ candidates: [{ content: { parts: [call, call] } }] }) +
      frame({ candidates: [{ finishReason: 'STOP' }] });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const chunks = await collect(adapter, fakeFetch);
    assert.equal(chunks.filter((chunk) => chunk.type === 'tool_call').length, 2);
  });
});
