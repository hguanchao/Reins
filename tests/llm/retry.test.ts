import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withRetry } from '../../src/llm/retry.ts';

describe('重试工具', () => {
  it('首次成功不等待', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    }, { attempts: 3, sleep: async () => {} });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('失败后按退避重试直至成功', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('暂时失败');
        }
        return calls;
      },
      { attempts: 5, sleep: async (ms) => void waits.push(ms) },
    );
    assert.equal(result, 3);
    assert.equal(waits.length, 2);
    assert.ok((waits[0] ?? 0) > 0);
  });

  it('不可重试的错误立即抛出', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error('不该重试');
          },
          { attempts: 5, retriable: () => false, sleep: async () => {} },
        ),
      /不该重试/,
    );
    assert.equal(calls, 1);
  });

  it('耗尽尝试次数后抛出最后一次错误', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error(`第 ${calls} 次`);
          },
          { attempts: 3, sleep: async () => {} },
        ),
      /第 3 次/,
    );
    assert.equal(calls, 3);
  });
});
