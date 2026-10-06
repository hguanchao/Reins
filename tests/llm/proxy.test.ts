import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveProxyDispatcher } from '../../src/llm/proxy.ts';
import { ReinsError } from '../../src/util/errors.ts';

describe('出站代理', () => {
  it('未配置与显式空串都表示直连', async () => {
    assert.equal(await resolveProxyDispatcher(undefined), undefined);
    assert.equal(await resolveProxyDispatcher(''), undefined);
  });

  it('非空代理在缺少 undici 时给出可行动错误', async () => {
    // 当前依赖集不含 undici,预期以 ReinsError 报出;若将来内置,则应返回 dispatcher
    const outcome = await resolveProxyDispatcher('http://127.0.0.1:7890').catch(
      (error: unknown) => error,
    );
    if (outcome instanceof ReinsError) {
      assert.ok(outcome.message.includes('undici'));
      assert.ok((outcome.hint ?? '').includes('proxy'));
    } else {
      assert.notEqual(outcome, undefined);
    }
  });
});
