import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSgrSpec, sgr, stripSgr } from '../../src/util/ansi.ts';

describe('SGR 颜色规格', () => {
  it('sgr 包裹与无色退化', () => {
    assert.equal(sgr('36', 'hi'), '\u001b[36mhi\u001b[0m');
    assert.equal(sgr('', 'hi'), 'hi');
  });

  it('stripSgr 去掉样式序列', () => {
    assert.equal(stripSgr('\u001b[1;36mhi\u001b[0m'), 'hi');
  });

  it('parseSgrSpec:颜色名、修饰符与组合', () => {
    assert.equal(parseSgrSpec('cyan'), '36');
    assert.equal(parseSgrSpec('bold cyan'), '1;36');
    assert.equal(parseSgrSpec('underline #8ab4f8'), '4;38;2;138;180;248');
    assert.equal(parseSgrSpec('200'), '38;5;200');
    assert.equal(parseSgrSpec('gray'), '90');
    assert.equal(parseSgrSpec('BOLD  RED'), '1;31');
  });

  it('parseSgrSpec:bg- 前缀解析为背景色', () => {
    assert.equal(parseSgrSpec('bg-brightblack'), '100');
    assert.equal(parseSgrSpec('bg-white'), '47');
    assert.equal(parseSgrSpec('bold bg-#303030'), '1;48;2;48;48;48');
    assert.equal(parseSgrSpec('bg-236'), '48;5;236');
    assert.equal(parseSgrSpec('bg-purplish'), undefined);
  });

  it('parseSgrSpec:非法输入返回 undefined', () => {
    assert.equal(parseSgrSpec(''), undefined);
    assert.equal(parseSgrSpec('purplish'), undefined);
    assert.equal(parseSgrSpec('#12345'), undefined);
    assert.equal(parseSgrSpec('256'), undefined);
  });
});
