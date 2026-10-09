import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTheme, symbols } from '../../src/tui/theme.ts';
import { visibleWidth } from '../../src/tui/layout.ts';

/** 从 SGR 码串里取出 `48;2;r;g;b` 的背景色。 */
function sgrBackground(codes: string): [number, number, number] | undefined {
  const match = /48;2;(\d+);(\d+);(\d+)/.exec(codes);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 从 SGR 码串里取出 `38;2;r;g;b` 的前景色。 */
function sgrForeground(codes: string): [number, number, number] | undefined {
  const match = /38;2;(\d+);(\d+);(\d+)/.exec(codes);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG 相对亮度。 */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度。 */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('主题', () => {
  it('默认 dark:角色取色可用', () => {
    const theme = createTheme({ color: true });
    assert.equal(theme.name, 'dark');
    assert.equal(theme.paint.accent('x'), '\u001b[38;2;127;167;207mx\u001b[0m');
    assert.equal(theme.paint.fail('x'), '\u001b[38;2;196;141;141mx\u001b[0m');
    assert.equal(theme.codes.accent, '38;2;127;167;207');
    // 分割线刻意压暗,只作视觉分界
    assert.equal(theme.codes.separator, '38;2;36;36;36');
    assert.equal(theme.paint.separator('─'), '\u001b[38;2;36;36;36m─\u001b[0m');
  });

  it('角色取色全局固定:每个角色都有值,消息条同时给定前景与背景', () => {
    const theme = createTheme({ color: true });
    for (const role of Object.keys(theme.codes)) {
      assert.notEqual(theme.codes[role as keyof typeof theme.codes], '', `角色 ${role} 缺少取色`);
    }
    // 只设背景会跟着终端默认前景走,条带里的文字可能看不清
    assert.ok(theme.codes.userBar.includes('38;'));
    assert.ok(theme.codes.userBar.includes('48;'));
    assert.equal(theme.codes.completionBg, '48;2;36;36;36');
    assert.equal(theme.codes.completionBorder, '38;2;36;36;36');
    assert.equal(theme.codes.userBar.split(';48;2;')[1], '36;36;36');
    // 滚动条比用户消息底色再暗一档
    assert.equal(theme.codes.scrollbar, '38;2;28;28;28');
  });

  it('角色按表面分四组:每组都有取值,四组之并即全部角色', () => {
    const theme = createTheme({ color: true });
    // 分组是维护契约:每个角色只属于一组,新增角色必须落进某一组
    const groups = {
      base: ['muted', 'ok', 'warn', 'fail'],
      tui: ['accent', 'userBar', 'scrollbar', 'completionBg', 'completionBorder', 'separator'],
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

  it('light 预设与 dark 不同:表面用浅底,前景在浅底上可读', () => {
    const dark = createTheme({ preset: 'dark', color: true });
    const light = createTheme({ preset: 'light', color: true });
    assert.notEqual(light.codes.accent, dark.codes.accent);
    assert.equal(light.codes.accent, '38;2;63;107;156');

    // 用户消息条与补全菜单的底色必须是浅色:沿用深色底会让深色前景在浅色终端上不可读
    const userBarBackground = sgrBackground(light.codes.userBar);
    const completionBackground = sgrBackground(light.codes.completionBg);
    assert.notEqual(userBarBackground, undefined, 'userBar 应同时给定前景与背景');
    assert.notEqual(completionBackground, undefined, 'completionBg 应给定背景色');
    if (userBarBackground === undefined || completionBackground === undefined) {
      return; // 仅用于类型收窄;上面的断言已保证不可达
    }
    assert.ok(relativeLuminance(userBarBackground) > 0.5, 'light 的用户消息条应为浅底');
    assert.ok(relativeLuminance(completionBackground) > 0.5, 'light 的补全菜单应为浅底');

    // 深色前景落在浅底上的对比度需达到 WCAG AA(4.5)
    const userBarForeground = sgrForeground(light.codes.userBar);
    assert.notEqual(userBarForeground, undefined);
    if (userBarForeground !== undefined) {
      assert.ok(contrastRatio(userBarForeground, userBarBackground) >= 4.5);
    }
  });

  it('状态标记是单宽文本符号,不会被渲染成彩色 emoji', () => {
    for (const glyph of [symbols.ok, symbols.fail, symbols.warn]) {
      assert.equal(visibleWidth(glyph), 1, `${glyph} 应为单宽`);
      // 变体选择符会让部分终端改用 emoji 呈现(彩色、双宽)
      assert.equal(/[\uFE0E\uFE0F]/.test(glyph), false, `${glyph} 不应带变体选择符`);
    }
    assert.equal(symbols.warn, '!');
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
