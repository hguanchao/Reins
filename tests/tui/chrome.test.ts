import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  headerLine,
  inputBoxFrame,
  inputBoxLine,
  scrollbarChar,
  scrollbarGeometry,
} from '../../src/tui/chrome.ts';
import { createTheme } from '../../src/tui/theme.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';

const theme = createTheme({ color: true });

describe('header 行', () => {
  it('两端对齐,无任何边框字符', () => {
    const line = headerLine('Reins · model', '12% ctx', 60, theme);
    assert.equal(visibleWidth(line), 60);
    const plain = stripAnsi(line);
    assert.ok(plain.startsWith('Reins · model'));
    assert.ok(plain.endsWith('12% ctx'));
    assert.ok(!/[┌┐└┘├┤╭╮╰╯─│]/.test(plain), 'header 不应包含边框字符');
  });

  it('右侧为空时只输出左侧内容', () => {
    const line = headerLine('Reins', '', 40, theme);
    assert.equal(stripAnsi(line), 'Reins');
  });

  it('窄宽度下左侧截断、右侧优先保留', () => {
    const longLeft = '很长的左侧信息很长的左侧信息很长的左侧信息很长的左侧信息';
    const line = headerLine(longLeft, '5% ctx', 30, theme);
    const plain = stripAnsi(line);
    assert.equal(visibleWidth(line), 30);
    assert.ok(plain.includes('5% ctx'));
    assert.ok(plain.includes('…'));
  });
});

describe('输入框边框', () => {
  it('上下沿占满整行', () => {
    const { top, bottom } = inputBoxFrame(40, theme);
    assert.equal(stripAnsi(top), `┌${'─'.repeat(38)}┐`);
    assert.equal(stripAnsi(bottom), `└${'─'.repeat(38)}┘`);
  });

  it('内容行两侧竖线夹住并补齐到右缘', () => {
    const line = inputBoxLine('› 你好', 40, theme);
    const plain = stripAnsi(line);
    assert.ok(plain.startsWith('│ › 你好'));
    assert.ok(plain.endsWith('│'));
    assert.equal(visibleWidth(line), 40);
  });

  it('超长内容按显示宽度截断', () => {
    const line = inputBoxLine('› ' + 'x'.repeat(100), 20, theme);
    assert.ok(visibleWidth(line) <= 20);
  });
});

describe('滚动条几何', () => {
  it('内容不溢出时不显示', () => {
    assert.equal(scrollbarGeometry(0, 10, 10), undefined);
    assert.equal(scrollbarGeometry(0, 10, 5), undefined);
  });

  it('滑块大小按视口占比,位置随滚动前进', () => {
    const start = scrollbarGeometry(0, 10, 100);
    if (start === undefined) throw new Error('应显示滚动条');
    assert.ok(start.thumbSize >= 1 && start.thumbSize <= 2);
    assert.equal(start.thumbStart, 0);
    assert.equal(scrollbarChar(0, start), 'thumb');
    assert.equal(scrollbarChar(9, start), 'track');

    const end = scrollbarGeometry(90, 10, 100);
    if (end === undefined) throw new Error('应显示滚动条');
    assert.equal(end.thumbStart + end.thumbSize, 10);
    assert.equal(scrollbarChar(9, end), 'thumb');
    assert.equal(scrollbarChar(0, end), 'track');
  });

  it('滚动越界时收敛到端点', () => {
    const over = scrollbarGeometry(999, 10, 100);
    if (over === undefined) throw new Error('应显示滚动条');
    assert.equal(over.thumbStart + over.thumbSize, 10);
    const negative = scrollbarGeometry(-5, 10, 100);
    if (negative === undefined) throw new Error('应显示滚动条');
    assert.equal(negative.thumbStart, 0);
  });
});
