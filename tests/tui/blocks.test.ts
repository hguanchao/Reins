import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBlockRenderer,
  renderBlock,
  renderBlockVerbose,
  summarizeToolArgs,
  type RenderContext,
  type ScrollBlock,
} from '../../src/tui/blocks.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';
import { createTheme } from '../../src/tui/theme.ts';

const context: RenderContext = { spinner: '⠋', theme: createTheme({ color: true }) };

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

  it('用户消息:中性灰条带、上下留白、› 前缀取强调色、不标注角色', () => {
    const lines = renderBlock({ kind: 'user', text: '修复登录页' }, 40, context);
    const plain = lines.map(stripAnsi);
    // 上下各一行空白条带,消息条有厚度
    assert.equal(plain[0]?.trim(), '');
    assert.equal(plain[plain.length - 1]?.trim(), '');
    assert.ok(plain[1]?.startsWith('› 修复登录页'));
    assert.equal(plain.join('\n').includes('你'), false);
    // 条带样式同时含前景与背景,不依赖终端默认前景色
    assert.ok(lines.every((line) => line.startsWith(`\u001b[${context.theme.codes.userBar}m`)));
    assert.ok(lines.every((line) => visibleWidth(line) === 40));
    // 前缀带强调色,且颜色不泄漏到正文
    const first = lines[1] ?? '';
    assert.ok(first.includes(`\u001b[${context.theme.codes.accent}m› `));
    assert.ok(first.includes(`\u001b[0m\u001b[${context.theme.codes.userBar}m`));
  });

  it('用户消息:折行后续行与首行对齐,不重复前缀', () => {
    const lines = renderBlock({ kind: 'user', text: '一二三四五六七八九十' }, 10, context).map(stripAnsi);
    // 去掉上下空白条带
    const body = lines.slice(1, -1);
    assert.ok(body[0]?.startsWith('› '));
    assert.ok(body.length > 1);
    assert.ok(body.slice(1).every((line) => line.startsWith('  ') && !line.includes('›')));
  });

  it('模型回复与用户消息正文左对齐', () => {
    const user = renderBlock({ kind: 'user', text: '任务' }, 40, context).map(stripAnsi);
    const assistant = renderBlock({ kind: 'assistant', text: '好的', streaming: false }, 40, context)
      .map(stripAnsi);
    const userText = user.find((line) => line.includes('任务')) ?? '';
    const assistantText = assistant.find((line) => line.includes('好的')) ?? '';
    assert.equal(assistantText.indexOf('好的'), userText.indexOf('任务'), '回复应与用户消息正文对齐');
  });

  it('助手消息:markdown 渲染且流式光标只在末尾', () => {
    const streaming = renderBlock(
      { kind: 'assistant', text: '# 标题\n正文', streaming: true },
      60,
      context,
    ).map(stripAnsi);
    assert.equal(streaming.some((line) => line.trim() === '助手'), false);
    // 正文缩进两格,与用户消息正文对齐
    assert.ok(streaming.some((line) => line === '  标题'));
    assert.ok(streaming[streaming.length - 1]?.includes('▏'));
    const idle = renderBlock({ kind: 'assistant', text: '完成', streaming: false }, 60, context)
      .map(stripAnsi)
      .join('\n');
    assert.equal(idle.includes('▏'), false);
  });

  it('助手消息 markdown:粗体与代码栅栏上样式', () => {
    const lines = renderBlock({ kind: 'assistant', text: '**粗**\n\n```ts\nlet x;\n```', streaming: false }, 60, context);
    const styled = lines.join('\n');
    assert.ok(styled.includes('\u001b[1m粗\u001b[0m'));
    assert.ok(styled.includes('\u001b[1;35mlet\u001b[0m'));
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

  it('工具输出默认折叠,失败带详情行', () => {
    const collapsed = render({
      kind: 'tool',
      name: 'bash',
      summary: 'cat log',
      state: 'ok',
      output: '第一行\n第二行',
    });
    assert.equal(collapsed.includes('第一行'), false);
    const failed = render({
      kind: 'tool',
      name: 'bash',
      summary: 'rm x',
      state: 'fail',
      elapsedMs: 50,
      output: '操作被拒绝\n更多',
      detail: '操作被拒绝',
    });
    assert.ok(failed.includes('✗'));
    assert.ok(failed.includes('↳ 操作被拒绝'));
    assert.equal(failed.includes('更多'), false);
  });

  it('工具块展开显示预览与剩余行数提示', () => {
    const output = Array.from({ length: 14 }, (_, index) => `第${index + 1}行`).join('\n');
    const lines = renderBlock(
      { kind: 'tool', name: 'read', summary: 'a', state: 'ok', output, expanded: true },
      60,
      context,
    ).map(stripAnsi);
    assert.ok(lines.some((line) => line.includes('第1行')));
    assert.ok(lines.some((line) => line.includes('第10行')));
    assert.equal(lines.some((line) => line.includes('第11行')), false);
    assert.ok(lines.some((line) => line.includes('共 14 行') && line.includes('Ctrl+O')));
  });

  it('查看器渲染:完整输出全部可见', () => {
    const output = Array.from({ length: 30 }, (_, index) => `行${index + 1}`).join('\n');
    const block: ScrollBlock = { kind: 'tool', name: 'read', summary: 'a', state: 'ok', output };
    const verbose = renderBlockVerbose(block, 60, context).map(stripAnsi).join('\n');
    assert.ok(verbose.includes('行1'));
    assert.ok(verbose.includes('行30'));
  });

  it('通知:三级样式均可渲染', () => {
    assert.ok(render({ kind: 'notice', text: '信息', level: 'info' }).includes('信息'));
    assert.ok(render({ kind: 'notice', text: '警告', level: 'warn' }).includes('⚠'));
    assert.ok(render({ kind: 'notice', text: '错误', level: 'error' }).includes('✗'));
  });

  it('欢迎面板:核心命令+快捷键、居中、边框闭合、说明列对齐', () => {
    const lines = renderBlock({ kind: 'welcome' }, 80, context).map(stripAnsi);
    const text = lines.join('\n');
    // 核心内容齐备
    assert.ok(text.includes('欢迎使用 Reins'));
    assert.ok(text.includes('/help'));
    assert.ok(text.includes('显示帮助'));
    assert.ok(text.includes('快捷键'));
    assert.ok(text.includes('Ctrl+O'));
    assert.ok(text.includes('@'));
    // 非核心项不展示(完整清单只在 /help)
    assert.ok(!text.includes('/compact'));
    assert.ok(!text.includes('Ctrl+E'));
    // 居中:所有行共享同一缩进
    const top = lines.find((line) => line.includes('┌'));
    if (top === undefined) throw new Error('应有边框');
    const indent = top.length - top.trimStart().length;
    assert.ok(indent > 0, '应水平居中');
    assert.ok(lines.every((line) => line === '' || line.startsWith(' '.repeat(indent))));
    // 边框闭合:所有行显示宽度一致(内容行不再短于边框行)
    const widths = new Set(lines.map((line) => visibleWidth(line)));
    assert.equal(widths.size, 1, `行宽不一致:${[...widths].join(',')}`);
    // 命令与快捷键共用一条说明列:跨节逐行对齐
    const helpLine = lines.find((line) => line.includes('/help'));
    const atLine = lines.find((line) => line.includes('@ '));
    const ctrlOLine = lines.find((line) => line.includes('Ctrl+O'));
    if (helpLine === undefined || atLine === undefined || ctrlOLine === undefined) {
      throw new Error('两节内容应存在');
    }
    const descColumn = helpLine.indexOf('显示帮助');
    assert.equal(atLine.indexOf('引用文件'), descColumn, '快捷键节说明列未对齐');
    assert.equal(ctrlOLine.indexOf('全屏查看输出'), descColumn, '快捷键节说明列未对齐');
  });

  it('欢迎面板:按键列取强调色,盒宽贴合内容', () => {
    const lines = renderBlock({ kind: 'welcome' }, 120, context);
    const helpLine = lines.find((line) => stripAnsi(line).includes('/help'));
    if (helpLine === undefined) throw new Error('应有 /help 行');
    assert.ok(helpLine.includes(`\u001b[${context.theme.codes.accent}m`), '按键列应取强调色');
    // 说明保持常规色,整块才不会发灰
    assert.equal(helpLine.includes(`\u001b[${context.theme.codes.accent}m显示帮助`), false);
    // 盒宽贴合内容,而不是撑满可用宽度
    const width = visibleWidth(lines[0] ?? '');
    assert.ok(width > 30 && width < 100, `盒宽应贴合内容,实际 ${width}`);
  });

  it('欢迎面板:各宽度下都不超宽且边框闭合', () => {
    for (const width of [30, 34, 40, 50, 80, 120]) {
      const lines = renderBlock({ kind: 'welcome' }, width, context);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `宽${width} 超宽:${stripAnsi(line)}`);
      }
      const widths = new Set(lines.map((line) => visibleWidth(line)));
      assert.equal(widths.size, 1, `宽${width} 行宽不一致:${[...widths].join(',')}`);
    }
  });

  it('渲染结果不超过给定宽度(含 CJK 与 emoji)', () => {
    const blocks: ScrollBlock[] = [
      { kind: 'user', text: '中文很长的任务描述会不会超过宽度呢可能会也可能不会但总之要检查一下' },
      { kind: 'assistant', text: '## 能力\n\n- 📁 **文件操作**\n- 🖥️ **命令行**:在你看工作区跑 shell 命令\n- 🛠 典型任务 | 我会怎么做', streaming: false },
      { kind: 'tool', name: 'bash', summary: '很长的命令参数需要截断处理', state: 'ok', elapsedMs: 12, output: '输出内容也很长需要折行处理输出内容也很长需要折行处理 📁📁📁' },
      { kind: 'notice', text: '这是一条很长的通知文本用于测试宽度截断行为是否正常 ⚠️', level: 'warn' },
    ];
    for (const block of blocks) {
      for (const line of renderBlock(block, 30, context)) {
        assert.ok(
          visibleWidth(line) <= 30,
          `行超宽(${visibleWidth(line)}): ${stripAnsi(line)}`,
        );
      }
    }
  });

  it('区块渲染器:同参数复用缓存,状态变化后重算', () => {
    const renderer = createBlockRenderer(context);
    const block: ScrollBlock = { kind: 'assistant', text: '你好', streaming: false };
    const first = renderer.render(block, 60);
    assert.equal(renderer.render(block, 60), first);
    block.text = '你好,世界';
    const second = renderer.render(block, 60);
    assert.notEqual(second, first);
    assert.ok(stripAnsi(second.join('\n')).includes('世界'));
  });
});
