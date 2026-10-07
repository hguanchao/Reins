import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  paintRow,
  fitPlain,
  fitStyledLine,
  padAnsi,
  renderStyledLine,
  softWrapRows,
  stripAnsi,
  truncateAnsi,
  truncatePlain,
  visibleWidth,
  visualRowContains,
  wrapPlain,
  wrapStyled,
} from '../../src/tui/layout.ts';

describe('布局宽度计算', () => {
  it('可见宽度:英文为 1、CJK 为 2、忽略 ANSI', () => {
    assert.equal(visibleWidth('abc'), 3);
    assert.equal(visibleWidth('你好'), 4);
    assert.equal(visibleWidth('你a好'), 5);
    assert.equal(visibleWidth('\u001b[36mhi\u001b[0m'), 2);
    assert.equal(stripAnsi('\u001b[36mhi\u001b[0m'), 'hi');
  });

  it('emoji 与变体选择符的宽度', () => {
    // 补充平面 emoji 按双宽
    assert.equal(visibleWidth('📁'), 2);
    assert.equal(visibleWidth('🖥'), 2);
    // BMP 符号:默认 emoji 呈现为 2,普通符号为 1
    assert.equal(visibleWidth('✅'), 2);
    assert.equal(visibleWidth('⏱'), 2);
    assert.equal(visibleWidth('⭐'), 2);
    assert.equal(visibleWidth('✓'), 1);
    // 成败标记:数学符号,不带 emoji 属性
    assert.equal(visibleWidth('√'), 1);
    assert.equal(visibleWidth('×'), 1);
    assert.equal(visibleWidth('⚠'), 1);
    // VS16 切换 emoji 呈现:基础符 1 + 选择符 1
    assert.equal(visibleWidth('\u2699\uFE0F'), 2);
    assert.equal(visibleWidth('\u2764\uFE0F'), 2);
    // 组合符号与零宽字符不占列
    assert.equal(visibleWidth('a\u0301'), 1);
    assert.equal(visibleWidth('\u200b'), 0);
    // 混排:emoji 两侧 CJK(2+2+2+2)
    assert.equal(visibleWidth('看📁文件'), 8);
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

  it('带样式折行:样式跟随片段,宽度按可见宽计算', () => {
    const segments = [
      { text: 'hello ', codes: '1' },
      { text: '美丽世界', codes: '36' },
    ];
    const lines = wrapStyled(segments, 7);
    assert.equal(lines.length, 3);
    assert.ok(visibleWidth(renderStyledLine(lines[0] ?? [])) <= 7);
    assert.ok(visibleWidth(renderStyledLine(lines[1] ?? [])) <= 7);
    assert.ok(visibleWidth(renderStyledLine(lines[2] ?? [])) <= 7);
    assert.ok(renderStyledLine(lines[0] ?? []).includes('\u001b[1m'));
    assert.ok(renderStyledLine(lines[1] ?? []).includes('\u001b[36m'));
  });

  it('带样式折行:相邻同样式片段合并,减少 SGR 切换', () => {
    const lines = wrapStyled(
      [
        { text: 'ab', codes: '' },
        { text: 'cd', codes: '' },
      ],
      10,
    );
    assert.equal(lines.length, 1);
    assert.equal((lines[0] ?? []).length, 1);
    assert.equal(stripAnsi(renderStyledLine(lines[0] ?? [])), 'abcd');
  });

  it('带样式折行:空内容得到单空行', () => {
    assert.deepEqual(wrapStyled([], 10), [[]]);
  });

  it('带样式折行:片段中的换行符强制断行', () => {
    const lines = wrapStyled([{ text: '第一行\n第二行', codes: '' }], 40);
    assert.deepEqual(lines.map((line) => stripAnsi(renderStyledLine(line))), ['第一行', '第二行']);
    // 换行在片段中间同样生效
    const mixed = wrapStyled([
      { text: '甲', codes: '1' },
      { text: '\n乙', codes: '36' },
    ], 40);
    assert.deepEqual(mixed.map((line) => stripAnsi(renderStyledLine(line))), ['甲', '乙']);
  });

  it('padAnsi:补齐空格、超宽截断、样式保留', () => {
    assert.equal(visibleWidth(padAnsi('ab', 5)), 5);
    assert.ok(padAnsi('ab', 5).endsWith('   '));
    assert.equal(visibleWidth(padAnsi('你好世界', 5)), 5);
    const styled = padAnsi('\u001b[36mhi\u001b[0m', 6);
    assert.equal(visibleWidth(styled), 6);
    assert.ok(styled.includes('\u001b[36m'));
    assert.equal(padAnsi('', 3), '   ');
    // emoji 按 2 列计,补齐后总宽不超
    assert.equal(visibleWidth(padAnsi('📁x', 5)), 5);
  });

  it('paintRow:样式包住补位空格,行内复位后条带样式不中断', () => {
    const style = '38;5;253;48;5;238';
    const filled = paintRow('ab', 5, style);
    assert.equal(visibleWidth(filled), 5);
    assert.ok(filled.startsWith(`\u001b[${style}m`));
    assert.ok(filled.endsWith('\u001b[0m'));
    // 补齐的空格也在条带样式之内
    assert.ok(filled.includes('ab   '));
    // 行内自带样式复位后,条带的前景与背景都要重新铺上
    const styled = paintRow('\u001b[36mhi\u001b[0m', 4, style);
    assert.equal(visibleWidth(styled), 4);
    assert.ok(styled.includes(`\u001b[0m\u001b[${style}m`));
  });

  it('softWrapRows:按显示宽度折行并记录各行起点', () => {
    assert.deepEqual(softWrapRows('abcdefgh', 4), [
      { text: 'abcd', start: 0 },
      { text: 'efgh', start: 4 },
    ]);
    // CJK 按双宽折行
    assert.deepEqual(softWrapRows('你好世界', 5), [
      { text: '你好', start: 0 },
      { text: '世界', start: 2 },
    ]);
    // 空文本得到单空行;零宽字符不产生空行
    assert.deepEqual(softWrapRows('', 4), [{ text: '', start: 0 }]);
    assert.deepEqual(softWrapRows('\u200bab', 4), [{ text: '\u200bab', start: 0 }]);
  });

  it('fitStyledLine:补齐、截断与样式保留', () => {
    assert.equal(fitStyledLine([{ text: 'ab', codes: '' }], 5), 'ab   ');
    // 超宽截断加省略号,并补齐到精确宽度(CJK 步进为 2,截断点后留 1 列补空格)
    assert.equal(fitStyledLine([{ text: '很长很长的一段中文内容', codes: '' }], 6), '很长… ');
    // 样式保留在截断后的片段上
    const cut = fitStyledLine([{ text: 'bold', codes: '1' }], 3);
    assert.equal(stripAnsi(cut), 'bo…');
    assert.ok(cut.includes('\u001b[1m'));
    // 任意输入的输出宽度都精确等于目标宽度
    assert.equal(visibleWidth(fitStyledLine([{ text: '📁📁📁', codes: '' }], 5)), 5);
    assert.equal(visibleWidth(fitStyledLine([{ text: '中文', codes: '' }], 7)), 7);
  });

  it('visualRowContains:行边界归属前一行', () => {
    const row = { start: 4, end: 8 };
    assert.equal(visualRowContains(row, 3), false);
    assert.equal(visualRowContains(row, 4), true);
    assert.equal(visualRowContains(row, 6), true);
    // 列等于 end 时归属本行,光标停在折行处显示为上一行行尾
    assert.equal(visualRowContains(row, 8), true);
    assert.equal(visualRowContains(row, 9), false);
  });
});
