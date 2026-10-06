import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReviewer } from '../../src/agent/reviewer.ts';
import type {
  AdapterRuntime,
  ProviderAdapter,
  StreamChunk,
  StreamRequest,
} from '../../src/llm/types.ts';

class CannedAdapter implements ProviderAdapter {
  readonly api = 'openai-completions';
  lastRequest: StreamRequest | undefined;
  private readonly replies: string[];
  private calls = 0;

  constructor(replies: string[]) {
    this.replies = replies;
  }

  async *stream(request: StreamRequest, _runtime: AdapterRuntime): AsyncIterable<StreamChunk> {
    this.lastRequest = request;
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)] ?? '';
    this.calls += 1;
    yield { type: 'text', text: reply };
    yield { type: 'done', finishReason: 'stop' };
  }
}

class FailingAdapter implements ProviderAdapter {
  readonly api = 'openai-completions';

  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('网络坏了');
  }
}

const model = {
  provider: 'demo',
  id: 'judge',
  api: 'openai-completions',
  baseUrl: 'https://demo.example/v1',
  contextWindow: 1000,
};

const target = { tool: 'bash', command: 'git push origin main' };
const decision = {
  verdict: 'ask' as const,
  rule: 'bash(git push *)',
  reason: '命中规则 bash(git push *)',
};

describe('审查模型', () => {
  it('ALLOW 放行,并在提示词中携带目标信息', async () => {
    const adapter = new CannedAdapter(['ALLOW']);
    const reviewer = createReviewer({ adapter, runtime: { maxRetries: 0 }, model });
    assert.equal(await reviewer.review(target, decision), 'allow');
    const content = adapter.lastRequest?.messages[0]?.content ?? '';
    assert.ok(content.includes('git push origin main'));
    assert.ok(content.includes('ALLOW 或 DENY'));
  });

  it('DENY 拒绝,大小写不敏感', async () => {
    const reviewer = createReviewer({
      adapter: new CannedAdapter(['deny']),
      runtime: { maxRetries: 0 },
      model,
    });
    assert.equal(await reviewer.review(target, decision), 'deny');
  });

  it('含糊回复(同时出现两个词)时保守拒绝', async () => {
    const reviewer = createReviewer({
      adapter: new CannedAdapter(['ALLOW 或者 DENY 均可']),
      runtime: { maxRetries: 0 },
      model,
    });
    assert.equal(await reviewer.review(target, decision), 'deny');
  });

  it('调用异常时保守拒绝', async () => {
    const reviewer = createReviewer({
      adapter: new FailingAdapter(),
      runtime: { maxRetries: 0 },
      model,
    });
    assert.equal(await reviewer.review(target, decision), 'deny');
  });
});
