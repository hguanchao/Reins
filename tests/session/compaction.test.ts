import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_COMPACT_THRESHOLD,
  buildCompactionPrompt,
  shouldCompact,
} from '../../src/session/compaction.ts';

describe('会话压缩策略', () => {
  it('按阈值判断是否压缩', () => {
    const window = 10000;
    assert.equal(shouldCompact(window * DEFAULT_COMPACT_THRESHOLD, window), true);
    assert.equal(shouldCompact(window * DEFAULT_COMPACT_THRESHOLD - 1, window), false);
    assert.equal(shouldCompact(100, 0), false);
    assert.equal(shouldCompact(6000, window, 0.5), true);
  });

  it('压缩提示词包含必要的保留项', () => {
    const prompt = buildCompactionPrompt('TRANSCRIPT-CONTENT');
    assert.ok(prompt.includes('TRANSCRIPT-CONTENT'));
    assert.ok(prompt.includes('未完成事项'));
    assert.ok(prompt.includes('下一步计划'));
  });
});
