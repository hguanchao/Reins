import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RenderContext, ScrollBlock } from '../../src/tui/blocks.ts';
import { Viewer } from '../../src/tui/viewer.ts';
import { createTheme } from '../../src/tui/theme.ts';
import { stripAnsi } from '../../src/tui/layout.ts';

const context: RenderContext = { spinner: '⠋', theme: createTheme({ color: true }) };

function sampleBlocks(): ScrollBlock[] {
  return [
    { kind: 'welcome' },
    { kind: 'user', text: '帮我看一下日志' },
    {
      kind: 'tool',
      name: 'read',
      summary: 'a.log',
      state: 'ok',
      elapsedMs: 12,
      output: Array.from({ length: 20 }, (_, index) => `日志第${index + 1}行`).join('\n'),
    },
    { kind: 'assistant', text: '结论', streaming: false },
  ];
}

describe('全屏查看器', () => {
  it('打开后渲染恰好指定行数,首行为标题', () => {
    const viewer = new Viewer();
    viewer.open(2);
    const rows = viewer.render(sampleBlocks(), 60, 10, context);
    assert.equal(rows.length, 10);
    assert.ok(stripAnsi(rows[0] ?? '').includes('工具 read'));
    assert.ok(stripAnsi(rows[0] ?? '').includes('第 1–8 行'));
  });

  it('滚动到底后再滚不越界', () => {
    const viewer = new Viewer();
    viewer.open(2);
    viewer.render(sampleBlocks(), 60, 10, context);
    viewer.scroll(100);
    const rows = viewer.render(sampleBlocks(), 60, 10, context);
    assert.ok(stripAnsi(rows[0] ?? '').includes('第 14–21 行'));
    // 输出行出现在视野内
    assert.ok(stripAnsi(rows.join('\n')).includes('日志第20行'));
  });

  it('n/p 在区块间切换,边界停住', () => {
    const viewer = new Viewer();
    viewer.open(2);
    viewer.step(1, 4);
    assert.equal(viewer.targetIndex, 3);
    viewer.step(1, 4);
    assert.equal(viewer.targetIndex, 3);
    viewer.step(-1, 4);
    assert.equal(viewer.targetIndex, 2);
    // 切换后回到顶部
    const rows = viewer.render(sampleBlocks(), 60, 10, context);
    assert.ok(stripAnsi(rows[0] ?? '').includes('第 1–'));
  });

  it('关闭后不再渲染内容', () => {
    const viewer = new Viewer();
    viewer.open(1);
    viewer.close();
    assert.equal(viewer.isOpen, false);
    const rows = viewer.render(sampleBlocks(), 60, 10, context);
    assert.equal(rows.length, 10);
    assert.ok(stripAnsi(rows[0] ?? '').includes('没有可查看的内容'));
  });

  it('end 直达末尾,home 回顶部', () => {
    const viewer = new Viewer();
    viewer.open(2);
    viewer.render(sampleBlocks(), 60, 10, context);
    viewer.end();
    let rows = viewer.render(sampleBlocks(), 60, 10, context);
    assert.ok(stripAnsi(rows[0] ?? '').includes('第 14–21 行'));
    viewer.home();
    rows = viewer.render(sampleBlocks(), 60, 10, context);
    assert.ok(stripAnsi(rows[0] ?? '').includes('第 1–8 行'));
  });

  it('区块内容变化后缓存失效', () => {
    const viewer = new Viewer();
    const blocks = sampleBlocks();
    viewer.open(2);
    viewer.render(blocks, 60, 10, context);
    const tool = blocks[2];
    if (tool === undefined || tool.kind !== 'tool') throw new Error('应为工具块');
    tool.output = '只有一行';
    const rows = viewer.render(blocks, 60, 10, context);
    // 标题行数 = 标题 1 行 + 输出 1 行
    assert.ok(stripAnsi(rows[0] ?? '').includes('共 2 行'));
  });
});
