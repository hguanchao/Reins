import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeFrameDiff } from '../../src/tui/screen.ts';

describe('帧差分', () => {
  it('相同帧无差异', () => {
    assert.deepEqual(computeFrameDiff(['a', 'b'], ['a', 'b']), []);
  });

  it('只输出变化行', () => {
    const diffs = computeFrameDiff(['a', 'b', 'c'], ['a', 'X', 'c']);
    assert.deepEqual(diffs, [{ row: 1, text: 'X' }]);
  });

  it('新增行也计入差异', () => {
    const diffs = computeFrameDiff(['a'], ['a', 'b', 'c']);
    assert.deepEqual(diffs, [
      { row: 1, text: 'b' },
      { row: 2, text: 'c' },
    ]);
  });

  it('空帧视为全量变化', () => {
    const diffs = computeFrameDiff([], ['x', 'y']);
    assert.equal(diffs.length, 2);
  });
});
