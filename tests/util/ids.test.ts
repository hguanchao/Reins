import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uuidv7 } from '../../src/util/ids.ts';

/** v7 的硬约束:版本位是 7、variant 是 10xx、全小写 36 字符。 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 从 id 的前 48 位还原毫秒时间戳。 */
function millisOf(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

describe('UUID v7', () => {
  it('形态固定:36 字符、小写、版本位 7', () => {
    for (const id of [uuidv7(), uuidv7(), uuidv7()]) {
      assert.equal(id.length, 36);
      assert.match(id, UUID_V7);
    }
  });

  it('前 48 位就是创建时刻,能反解出来', () => {
    const now = Date.now();
    assert.equal(millisOf(uuidv7(now)), now);
  });

  it('字典序等于生成顺序:同一毫秒连号也不重、不倒退', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_700_000_000_100));
    assert.equal(new Set(ids).size, ids.length, '序号用尽后要自动把时间推后一毫秒,不许重号');
    assert.deepEqual(ids, [...ids].sort(), '生成序应等于字典序');
  });

  it('时钟回拨不产生倒退的 id', () => {
    const ahead = uuidv7(1_900_000_000_000);
    const behind = uuidv7(1_000);
    assert.ok(behind > ahead, '回拨的时刻被钉在上一个毫秒上');
    assert.ok(millisOf(behind) >= millisOf(ahead), '时间字段只许朝前走');
  });

  it('跨毫秒仍然严格递增,前一条不会盖住后一条', () => {
    const earlier = uuidv7(1_950_000_000_000);
    const later = uuidv7(1_950_000_000_500);
    assert.ok(later > earlier);
    assert.equal(millisOf(later), 1_950_000_000_500);
  });
});
