import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fitPlain,
  stripAnsi,
  truncateAnsi,
  truncatePlain,
  visibleWidth,
  wrapPlain,
} from '../../src/tui/layout.ts';

describe('布局宽度计算', () => {
  it('可见宽度:英文为 1、CJK 为 2、忽略 ANSI', () => {
    assert.equal(visibleWidth('abc'), 3);
    assert.equal(visibleWidth('你好'), 4);
    assert.equal(visibleWidth('你a好'), 5);
    assert.equal(visibleWidth('\u001b[36mhi\u001b[0m'), 2);
    assert.equal(stripAnsi('\u001b[36mhi\u001b[0m'), 'hi');
  });

  it('截断:超宽加省略号,宽度内原样', () => {
    assert.equal(truncatePlain('你好世界', 5), '你好…');
    assert.equal(truncatePlain('hello', 5), 'hello');
    assert.equal(truncatePlain('hello', 4), 'hel…');
    assert.equal(truncatePlain('你好', 1), '…');
  });

  it('截断带样式文本并保留样式序列', () => {
    const styled = '\u001b[36mhello world\u001b[0m';
    const cut = truncateAnsi(styled, 6);
    assert.equal(visibleWidth(cut), 6);
    assert.ok(cut.startsWith('\u001b[36m'));
    assert.ok(cut.endsWith('\u001b[0m'));
    assert.equal(stripAnsi(cut), 'hello…');
  });

  it('填充到指定宽度', () => {
    assert.equal(fitPlain('ab', 5), 'ab   ');
    assert.equal(fitPlain('abcdefg', 5), 'abcd…');
  });

  it('折行:英文按单词、中文硬折', () => {
    assert.deepEqual(wrapPlain('hello world foo', 8), ['hello', 'world', 'foo']);
    assert.deepEqual(wrapPlain('你好世界', 5), ['你好', '世界']);
    assert.deepEqual(wrapPlain('aaaaaaaa', 4), ['aaaa', 'aaaa']);
  });

  it('折行保留手动换行', () => {
    assert.deepEqual(wrapPlain('a\nb', 10), ['a', 'b']);
  });
});
