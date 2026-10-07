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

  it('角色取色全局固定:每个角色都有值,消息条同时给定前景与背景', () => {
    const theme = createTheme({ color: true });
    for (const role of Object.keys(theme.codes)) {
      assert.notEqual(theme.codes[role as keyof typeof theme.codes], '', `角色 ${role} 缺少取色`);
    }
    // 只设背景会跟着终端默认前景走,条带里的文字可能看不清
    assert.ok(theme.codes.userBar.includes('38;'));
    assert.ok(theme.codes.userBar.includes('48;'));
  });

  it('角色按表面分四组:每组都有取值,四组之并即全部角色', () => {
    const theme = createTheme({ color: true });
    // 分组是维护契约:每个角色只属于一组,新增角色必须落进某一组
    const groups = {
      base: ['muted', 'ok', 'warn', 'fail'],
      tui: ['accent', 'userBar'],
      markdown: ['heading', 'code', 'link'],
      highlight: ['keyword', 'string', 'comment', 'number', 'function', 'type'],
    } as const;
    for (const [name, roles] of Object.entries(groups)) {
      for (const role of roles) {
        assert.notEqual(theme.codes[role], '', `${name} 组角色 ${role} 缺少取色`);
      }
    }
    const all: string[] = Object.values(groups).flat();
    assert.deepEqual([...Object.keys(theme.codes)].sort(), [...all].sort());
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
