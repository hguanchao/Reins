import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contentHeight,
  createBlockRenderer,
  renderBlock,
  renderBlockVerbose,
  renderTrustPage,
  renderWindow,
  scrollWindow,
  summarizeToolArgs,
  type RenderContext,
  type ScrollBlock,
} from '../../src/tui/blocks.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';
import { createTheme } from '../../src/tui/theme.ts';
import { VERSION } from '../../src/util/version.ts';

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
    assert.ok(styled.includes(`\u001b[${context.theme.codes.keyword}mlet\u001b[0m`));
  });

  it('工具卡片:运行中与成功态', () => {
    const running = render({ kind: 'tool', name: 'read', summary: 'a.ts', state: 'running' });
    assert.ok(running.includes('read'));
    assert.ok(running.includes('运行中'));
    assert.ok(running.includes('⠋'));
    const ok = render({ kind: 'tool', name: 'bash', summary: 'git status', state: 'ok', elapsedMs: 320 });
    assert.ok(ok.includes('√'));
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
    assert.ok(failed.includes('×'));
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
    assert.ok(render({ kind: 'notice', text: '警告', level: 'warn' }).includes('!'));
    assert.ok(render({ kind: 'notice', text: '错误', level: 'error' }).includes('×'));
  });

  it('欢迎页:品牌名带版本 + 一句描述,两行都居中', () => {
    const lines = renderBlock({ kind: 'welcome' }, 80, context).map(stripAnsi);
    assert.deepEqual(lines.map((line) => line.trim()), [
      `Reins v${VERSION}`,
      '可控优先的编程智能体',
    ]);
    for (const line of lines) {
      const lead = line.length - line.trimStart().length;
      assert.equal(lead, Math.floor((80 - visibleWidth(line.trim())) / 2), `应水平居中:${JSON.stringify(line)}`);
    }
  });

  it('欢迎页两行都取灰,不再出现盒框与命令清单', () => {
    const raw = renderBlock({ kind: 'welcome' }, 80, context);
    const muted = `\u001b[${context.theme.codes.muted}m`;
    assert.ok(raw.every((line) => line.includes(muted)), '两行都该是灰(muted)');
    const text = raw.map(stripAnsi).join('\n');
    assert.equal(/[╭╰┌└│─]/.test(text), false, '欢迎页不该再有边框');
    assert.equal(text.includes('/help'), false);
    assert.equal(text.includes('Ctrl+'), false);
  });

  it('欢迎页在各种宽度下都只有两行且不超宽', () => {
    for (const width of [20, 30, 80, 120]) {
      const lines = renderBlock({ kind: 'welcome' }, width, context);
      assert.equal(lines.length, 2, `宽${width} 该行数应为 2`);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `宽${width} 超宽:${stripAnsi(line)}`);
      }
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

  it('区块渲染器:行数取自缓存,离屏区块回收后重新渲染', () => {
    const renderer = createBlockRenderer(context);
    const block: ScrollBlock = { kind: 'assistant', text: '第一行', streaming: false };
    const lines = renderer.render(block, 60);
    assert.equal(renderer.height(block, 60), lines.length);

    // 区块变长后行数跟着变
    block.text = '第一行\n\n第二行';
    assert.ok(renderer.height(block, 60) > lines.length);

    // 保留的区块复用同一份行
    const kept = renderer.render(block, 60);
    renderer.release([block], [block]);
    assert.equal(renderer.render(block, 60), kept);

    // 回收的区块只留行数:再次渲染会重算,内容不变
    renderer.release([block], []);
    const again = renderer.render(block, 60);
    assert.notEqual(again, kept);
    assert.deepEqual(again, kept);
    assert.equal(renderer.height(block, 60), kept.length);
  });

  it('整段内容行数:区块之间空一行', () => {
    assert.equal(contentHeight([]), 0);
    assert.equal(contentHeight([3]), 3);
    assert.equal(contentHeight([3, 2]), 6);
    assert.equal(contentHeight([0, 3]), 3);
    assert.equal(contentHeight([3, 0, 2]), 7);
  });
});

describe('视口窗口', () => {
  const width = 40;
  const viewHeight = 8;

  /** 未窗口化时的整段内容:窗口化的结果必须与它逐行一致。 */
  function fullContent(blocks: readonly ScrollBlock[]): string[] {
    const lines: string[] = [];
    for (const block of blocks) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(...renderBlock(block, width, context));
    }
    return lines;
  }

  const blocks: ScrollBlock[] = [
    { kind: 'user', text: '把登录页的错误提示改成中文' },
    { kind: 'assistant', text: '好的\n\n我来改。', streaming: false },
    { kind: 'tool', name: 'edit', summary: 'src/login.tsx', state: 'ok', elapsedMs: 12 },
    { kind: 'assistant', text: '已改完。', streaming: false },
    { kind: 'notice', text: '状态已更新', level: 'info' },
    // 空区块:不画行,但仍然参与排版
    { kind: 'assistant', text: '', streaming: false },
    { kind: 'user', text: '再检查一下' },
  ];

  it('无区块时窗口为空', () => {
    assert.deepEqual(scrollWindow([], 0, viewHeight), { start: 0, end: -1, total: 0, skip: 0 });
    assert.deepEqual(renderWindow([], scrollWindow([], 0, viewHeight), () => ['x']), []);
  });

  it('窗口内物化的行与整段内容逐行一致', () => {
    const heights = blocks.map((block) => renderBlock(block, width, context).length);
    const full = fullContent(blocks);
    assert.equal(contentHeight(heights), full.length);

    for (let top = 0; top <= full.length; top += 1) {
      const window = scrollWindow(heights, top, viewHeight);
      const materialized = renderWindow(blocks, window, (block) => renderBlock(block, width, context));
      const expected = full.slice(top, top + viewHeight);
      while (expected.length < viewHeight) {
        expected.push('');
      }
      const actual = materialized.slice(0, viewHeight);
      while (actual.length < viewHeight) {
        actual.push('');
      }
      assert.deepEqual(actual, expected, `top=${top} 时窗口内容与整段内容不一致`);
    }
  });

  it('只物化视口附近的区块', () => {
    const heights = blocks.map((block) => renderBlock(block, width, context).length);
    const window = scrollWindow(heights, 0, viewHeight);
    assert.equal(window.start, 0);
    assert.ok(window.end < blocks.length - 1, '视口在顶部时不该物化到最后一个区块');
    assert.equal(window.skip, 0);
  });

  it('内容不足一屏时整段物化且不裁切', () => {
    const heights = blocks.map((block) => renderBlock(block, width, context).length);
    const total = contentHeight(heights);
    const window = scrollWindow(heights, 0, total + 20);
    assert.equal(window.start, 0);
    assert.equal(window.end, blocks.length - 1);
    assert.equal(window.skip, 0);
  });

  it('滚到底部时裁掉头部偏移', () => {
    const heights = blocks.map((block) => renderBlock(block, width, context).length);
    const total = contentHeight(heights);
    const top = total - viewHeight;
    const window = scrollWindow(heights, top, viewHeight);
    assert.equal(window.end, blocks.length - 1);
    const materialized = renderWindow(blocks, window, (block) => renderBlock(block, width, context));
    assert.ok(materialized.length >= viewHeight);
    assert.deepEqual(materialized.slice(0, viewHeight), fullContent(blocks).slice(top));
  });

  it('视口越出内容范围时下标仍然合法', () => {
    const heights = [3, 0, 2];
    for (const top of [0, 1, 5, 99]) {
      const window = scrollWindow(heights, top, 4);
      assert.ok(window.start >= 0 && window.start < heights.length);
      assert.ok(window.end >= window.start && window.end < heights.length);
      assert.ok(window.skip >= 0);
    }
  });
});

describe('信任页渲染', () => {
  function page(
    input: { path: string; overrides: { label: string; detail: string }[]; docs: string[] },
    width = 60,
  ): string {
    return renderTrustPage(width, context.theme, input).map(stripAnsi).join('\n');
  }

  it('同时列出会被覆盖的配置与会被注入的说明文件', () => {
    const text = page({
      path: 'E:/Projects/Reins',
      overrides: [{ label: '审批模式', detail: 'ask(默认) → yolo' }],
      docs: ['REINS.md', 'AGENTS.md'],
    });
    assert.ok(text.includes('信任这个目录吗?'));
    assert.ok(text.includes('E:/Projects/Reins'));
    assert.ok(text.includes('覆盖全局配置:'));
    assert.ok(text.includes('审批模式  ask(默认) → yolo'));
    // 说明文件与标签同一行,不逐个换行
    assert.ok(text.includes('注入项目说明文件: REINS.md、AGENTS.md'));
  });

  it('两者皆空时如实说明,不留空标题', () => {
    const text = page({ path: '/tmp/scratch', overrides: [], docs: [] });
    assert.ok(text.includes('(该目录没有项目层配置,也没有说明文件)'));
    assert.equal(text.includes('覆盖全局配置'), false);
    assert.equal(text.includes('注入项目说明文件'), false);
  });

  it('只有说明文件时不出现覆盖标题', () => {
    const text = page({ path: '/tmp/repo', overrides: [], docs: ['AGENTS.md'] });
    assert.equal(text.includes('覆盖全局配置'), false);
    assert.ok(text.includes('注入项目说明文件: AGENTS.md'));
  });

  it('窄终端下每一行都不超宽', () => {
    const lines = renderTrustPage(
      40,
      context.theme,
      {
        path: 'E:/Projects/Reins/very/nested/workspace/path',
        overrides: [{ label: '权限规则', detail: 'deny 0 条 → 12 条 · allow 0 条 → 9 条' }],
        docs: ['AGENTS.md'],
      },
    );
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 40, `行超宽(${visibleWidth(line)}): ${stripAnsi(line)}`);
    }
  });
});
