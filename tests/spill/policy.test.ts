import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPreview, buildSpillNotice, shouldSpill } from '../../src/spill/policy.ts';

describe('落盘策略', () => {
  it('阈值判定', () => {
    assert.equal(shouldSpill('x'.repeat(101), 100), true);
    assert.equal(shouldSpill('x'.repeat(100), 100), false);
    assert.equal(shouldSpill('x'.repeat(1000), 0), false);
  });

  it('预览截取前缀', () => {
    assert.equal(buildPreview('abcdef', 3), 'abc');
  });

  it('提示文本包含位置、总量与预览', () => {
    const notice = buildSpillNotice('/spill/a.txt', 12345, 'PREVIEW');
    assert.ok(notice.includes('/spill/a.txt'));
    assert.ok(notice.includes('12345'));
    assert.ok(notice.includes('PREVIEW'));
  });
});
