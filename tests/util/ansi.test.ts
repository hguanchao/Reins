import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeTerminalText, sgr, stripSgr } from '../../src/util/ansi.ts';

describe('SGR 序列', () => {
  it('sgr 包裹与无色退化', () => {
    assert.equal(sgr('36', 'hi'), '\u001b[36mhi\u001b[0m');
    assert.equal(sgr('', 'hi'), 'hi');
  });

  it('stripSgr 去掉样式序列', () => {
    assert.equal(stripSgr('\u001b[1;36mhi\u001b[0m'), 'hi');
  });
});

describe('终端文本净化', () => {
  it('剥掉光标、清屏与 OSC 等转义序列', () => {
    assert.equal(sanitizeTerminalText('a\u001b[2Jb'), 'ab');
    assert.equal(sanitizeTerminalText('a\u001b]0;标题\u0007b'), 'ab');
    assert.equal(sanitizeTerminalText('a\u001b[1;31mred'), 'ared');
  });

  it('保留换行与制表,去掉其余控制符', () => {
    assert.equal(sanitizeTerminalText('a\nb\tc\u0000d'), 'a\nb\tcd');
  });

  it('孤立的 ESC 也被清掉', () => {
    assert.equal(sanitizeTerminalText('x\u001by'), 'xy');
  });
});
