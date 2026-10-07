import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../../src/tui/markdown.ts';
import { createTheme } from '../../src/tui/theme.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';

const theme = createTheme({ color: true });

function render(text: string, width = 60): string[] {
  return renderMarkdown(text, width, theme).map(stripAnsi);
}

describe('markdown 渲染', () => {
  it('标题与正文段落', () => {
    const lines = render('# 大标题\n\n正文一段。');
    assert.equal(lines[0], '  大标题');
    assert.equal(lines[2], '  正文一段。');
  });

  it('行内样式:粗体、斜体、行内代码、链接', () => {
    const lines = renderMarkdown('**粗** 和 *斜* 和 `code` 和 [名](https://x.y)', 60, theme);
    const styled = lines.join('\n');
    assert.ok(styled.includes('\u001b[1m粗\u001b[0m'));
    assert.ok(styled.includes('\u001b[3m斜\u001b[0m'));
    assert.ok(styled.includes('\u001b[96mcode\u001b[0m'));
    assert.ok(styled.includes('https://x.y'));
  });

  it('下划线标识符不被当作斜体', () => {
    const lines = render('用 my_var_name 即可');
    assert.ok(lines[0]?.includes('my_var_name'));
  });

  it('代码栅栏:画框并保留内容', () => {
    const lines = render('```ts\nconst a = 1;\nconst b = 2;\n```');
    assert.ok(lines[0]?.startsWith('  ╭─ ts'));
    assert.ok(lines.some((line) => line.includes('const a = 1;')));
    assert.ok(lines.at(-1)?.startsWith('  ╰'));
  });

  it('流式中未闭合的代码栅栏按代码块渲染', () => {
    const lines = render('```python\nx = 1');
    assert.ok(lines[0]?.startsWith('  ╭─ python'));
    assert.ok(lines.some((line) => line.includes('x = 1;') === false));
    assert.ok(lines.some((line) => line.includes('x = 1')));
  });

  it('列表与嵌套续行', () => {
    const lines = render('- 第一项\n- 第二项\n  续行内容\n  - 嵌套项');
    assert.ok(lines.some((line) => line.includes('• 第一项')));
    assert.ok(lines.some((line) => line.includes('• 第二项')));
    assert.ok(lines.some((line) => line.includes('续行内容')));
    assert.ok(lines.some((line) => line.includes('嵌套项')));
  });

  it('有序列表保留编号', () => {
    const lines = render('1. 甲\n2. 乙');
    assert.ok(lines.some((line) => line.includes('1. 甲')));
    assert.ok(lines.some((line) => line.includes('2. 乙')));
  });

  it('引用块加竖线前缀', () => {
    const lines = render('> 引用的话');
    assert.ok(lines[0]?.includes('▌'));
    assert.ok(lines[0]?.includes('引用的话'));
  });

  it('分隔线渲染为横线', () => {
    const lines = render('上面\n\n---\n\n下面');
    assert.ok(lines.some((line) => /^  ─+$/.test(line)));
  });

  it('超长中文段落按宽度硬折且不超宽', () => {
    const lines = render('很长的一段中文内容没有任何空格需要按照显示宽度进行硬折行处理才行', 20);
    for (const line of lines) {
      assert.ok(line === '' || visibleWidth(line) <= 20, `超宽:${line}`);
    }
  });

  it('表格渲染出边框与列', () => {
    const lines = render('| 左 | 右 |\n| --- | --- |\n| a | b |', 40);
    const text = lines.map(stripAnsi).join('\n');
    assert.ok(text.includes('左'));
    assert.ok(text.includes('右'));
    assert.ok(text.includes('a'));
    assert.ok(text.includes('│'));
  });

  it('无色主题下输出不含转义序列', () => {
    const mono = createTheme({ preset: 'mono', color: true });
    const lines = renderMarkdown('**粗体** 与 `code`', 40, mono);
    assert.ok(lines.every((line) => !line.includes('\u001b[')));
  });
});
