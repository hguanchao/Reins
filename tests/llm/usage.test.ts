import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addUsage, estimateCost, formatUsage, promptTokens } from '../../src/llm/usage.ts';

describe('用量与费用', () => {
  it('按单价估算费用', () => {
    const cost = { input: 1, output: 4, cacheRead: 0.1 };
    const money = estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, cost);
    assert.equal(money, 3);
  });

  it('未声明 cost 时不估算', () => {
    assert.equal(estimateCost({ inputTokens: 10, outputTokens: 10 }, undefined), undefined);
  });

  it('缓存 token 计入费用', () => {
    const money = estimateCost(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      { input: 1, output: 1, cacheRead: 0.5 },
    );
    assert.equal(money, 0.5);
  });

  it('用量累加', () => {
    const sum = addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 },
    );
    assert.deepEqual(sum, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: undefined });
  });

  it('摘要包含费用与缓存信息', () => {
    const text = formatUsage(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 5 },
      { input: 2, output: 2, cacheRead: 1 },
    );
    assert.ok(text.includes('输入 1000000'));
    assert.ok(text.includes('缓存读 5'));
    assert.ok(text.includes('$2.0000'));
  });

  it('摘要展示缓存写,与计费口径一致', () => {
    const text = formatUsage(
      { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 7 },
      { input: 1, output: 1, cacheWrite: 1 },
    );
    assert.ok(text.includes('缓存写 7'));
  });

  it('提示词总量:缓存读算在输入里的端点不重复相加', () => {
    // OpenAI 系 / Gemini:inputTokens 已含缓存读(缓存读是它的子集)
    assert.equal(promptTokens({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 90 }), 100);
    // 没有缓存信息时就是输入本身
    assert.equal(promptTokens({ inputTokens: 42, outputTokens: 1 }), 42);
  });

  it('提示词总量:缓存读单列的端点要相加', () => {
    // Anthropic:inputTokens 不含缓存读与缓存写
    assert.equal(
      promptTokens({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 80, cacheWriteTokens: 10 }),
      100,
    );
    assert.equal(promptTokens({ inputTokens: 10, outputTokens: 1, cacheWriteTokens: 5 }), 15);
  });
});
