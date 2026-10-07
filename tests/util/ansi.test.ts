import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sgr, stripSgr } from '../../src/util/ansi.ts';

describe('SGR 序列', () => {
  it('sgr 包裹与无色退化', () => {
    assert.equal(sgr('36', 'hi'), '\u001b[36mhi\u001b[0m');
    assert.equal(sgr('', 'hi'), 'hi');
  });

  it('stripSgr 去掉样式序列', () => {
    assert.equal(stripSgr('\u001b[1;36mhi\u001b[0m'), 'hi');
  });
});
