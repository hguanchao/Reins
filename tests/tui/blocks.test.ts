import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderBlock, summarizeToolArgs, type ScrollBlock } from '../../src/tui/blocks.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';

const context = { spinner: '⠋' };

function render(block: ScrollBlock, width = 60): string {
  return renderBlock(block, width, context).map(stripAnsi).join('\n');
}

describe('滚动区块渲染', () => {
  it('工具参数摘要:优先常见键', () => {
    assert.equal(summarizeToolArgs('{"path":"src/a.ts","content":"x"}'), 'src/a.ts');
    assert.equal(summarizeToolArgs('{"command":"git status"}'), 'git status');
    assert.equal(summarizeToolArgs('{"pattern":"错别字"}'), '错别字');
    assert.equal(summarizeToolArgs('not-json'), 'not-json');
    assert.equal(summarizeToolArgs('{}'), '{}');
  });

  it('用户消息:标题行与正文', () => {
    const text = render({ kind: 'user', text: '修复登录页' });
    assert.ok(text.includes('你'));
    assert.ok(text.includes('修复登录页'));
  });

  it('助手消息:流式光标只出现在最后一行', () => {
    const streaming = renderBlock(
      { kind: 'assistant', text: '第一行\n第二行', streaming: true },
      60,
      context,
    ).map(stripAnsi);
    assert.ok(streaming[streaming.length - 1]?.includes('▏'));
    const idle = renderBlock({ kind: 'assistant', text: '完成', streaming: false }, 60, context)
      .map(stripAnsi)
      .join('\n');
    assert.equal(idle.includes('▏'), false);
  });

  it('工具卡片:运行中与成功态', () => {
    const running = render({ kind: 'tool', name: 'read', summary: 'a.ts', state: 'running' });
    assert.ok(running.includes('read'));
    assert.ok(running.includes('运行中'));
    assert.ok(running.includes('⠋'));
    const ok = render({ kind: 'tool', name: 'bash', summary: 'git status', state: 'ok', elapsedMs: 320 });
    assert.ok(ok.includes('✓'));
    assert.ok(ok.includes('0.3s'));
  });

  it('工具失败带详情行', () => {
    const text = render({
      kind: 'tool',
      name: 'bash',
      summary: 'rm x',
      state: 'fail',
      elapsedMs: 50,
      detail: '操作被拒绝',
    });
    assert.ok(text.includes('✗'));
    assert.ok(text.includes('↳ 操作被拒绝'));
  });

  it('通知:三级样式均可渲染', () => {
    assert.ok(render({ kind: 'notice', text: '信息', level: 'info' }).includes('信息'));
    assert.ok(render({ kind: 'notice', text: '警告', level: 'warn' }).includes('⚠'));
    assert.ok(render({ kind: 'notice', text: '错误', level: 'error' }).includes('✗'));
  });

  it('欢迎卡含标题与提示', () => {
    const text = render({ kind: 'welcome' });
    assert.ok(text.includes('欢迎使用 Reins'));
    assert.ok(text.includes('/'));
  });

  it('渲染结果不超过给定宽度(含 CJK)', () => {
    const blocks: ScrollBlock[] = [
      { kind: 'user', text: '中文很长的任务描述会不会超过宽度呢可能会也可能不会但总之要检查一下' },
      { kind: 'tool', name: 'bash', summary: '很长的命令参数需要截断处理', state: 'ok', elapsedMs: 12 },
      { kind: 'notice', text: '这是一条很长的通知文本用于测试宽度截断行为是否正常', level: 'warn' },
    ];
    for (const block of blocks) {
      for (const line of renderBlock(block, 30, context)) {
        assert.ok(
          visibleWidth(line) <= 32,
          `行超宽(${visibleWidth(line)}): ${stripAnsi(line)}`,
        );
      }
    }
  });
});
