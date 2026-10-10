import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDiff, lineDiff } from '../../src/tools/diff.ts';

describe('紧凑行差异', () => {
  it('只给改动那一段,两侧留上下文', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    const after = ['a', 'b', 'c', 'X', 'e', 'f'].join('\n');
    assert.deepEqual(lineDiff(before, after), [
      { kind: 'context', text: 'b' },
      { kind: 'context', text: 'c' },
      { kind: 'remove', text: 'd' },
      { kind: 'add', text: 'X' },
      { kind: 'context', text: 'e' },
      { kind: 'context', text: 'f' },
    ]);
  });

  it('纯新增与纯删除', () => {
    assert.deepEqual(lineDiff('a\nb', 'a\nb\nc'), [
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
    assert.deepEqual(lineDiff('a\nb\nc', 'a\nc'), [
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('内容一致时没有增删行', () => {
    const lines = lineDiff('same\ntext', 'same\ntext');
    assert.ok(lines.every((line) => line.kind === 'context'), formatDiff(lines));
  });

  it('行数超限时中间省略', () => {
    const before = Array.from({ length: 40 }, (_, index) => `旧 ${index}`).join('\n');
    const after = Array.from({ length: 40 }, (_, index) => `新 ${index}`).join('\n');
    const lines = lineDiff(before, after, { maxLines: 8 });
    assert.equal(lines.length, 8);
    assert.ok(lines.some((line) => line.text.includes('省略')), formatDiff(lines));
  });

  it('渲染带前缀,末尾换行不算一行', () => {
    assert.equal(formatDiff(lineDiff('a\n', 'a\nb\n')), ' a\n+b');
  });
});
