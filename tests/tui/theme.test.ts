import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTheme } from '../../src/tui/theme.ts';

describe('主题', () => {
  it('默认 dark:角色取色可用', () => {
    const theme = createTheme({ color: true });
    assert.equal(theme.name, 'dark');
    assert.equal(theme.paint.accent('x'), '\u001b[1;36mx\u001b[0m');
    assert.equal(theme.paint.fail('x'), '\u001b[31mx\u001b[0m');
    assert.equal(theme.codes.accent, '1;36');
  });

  it('颜色按角色覆盖', () => {
    const theme = createTheme({ color: true, colors: { accent: '#ff0000', fail: 'bold magenta' } });
    assert.equal(theme.paint.accent('x'), '\u001b[38;2;255;0;0mx\u001b[0m');
    assert.equal(theme.paint.fail('x'), '\u001b[1;35mx\u001b[0m');
    assert.equal(theme.paint.ok('x'), '\u001b[32mx\u001b[0m');
  });

  it('light 预设与 dark 不同', () => {
    const dark = createTheme({ preset: 'dark', color: true });
    const light = createTheme({ preset: 'light', color: true });
    assert.notEqual(light.codes.accent, dark.codes.accent);
    assert.equal(light.codes.accent, '1;34');
  });

  it('mono 强制无颜色', () => {
    const theme = createTheme({ preset: 'mono', color: true });
    assert.equal(theme.useColor, false);
    assert.equal(theme.paint.accent('x'), 'x');
    assert.equal(theme.codes.accent, '');
    assert.equal(theme.bold('x'), 'x');
  });

  it('NO_COLOR 环境下自动退化', () => {
    const previous = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      const theme = createTheme();
      assert.equal(theme.useColor, false);
      assert.equal(theme.paint.accent('x'), 'x');
    } finally {
      if (previous === undefined) {
        delete process.env['NO_COLOR'];
      } else {
        process.env['NO_COLOR'] = previous;
      }
    }
  });
});
