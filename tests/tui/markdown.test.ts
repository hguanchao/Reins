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
    assert.ok(styled.includes(`\u001b[${theme.codes.code}mcode\u001b[0m`));
    assert.ok(styled.includes('https://x.y'));
  });

  it('下划线标识符不被当作斜体', () => {
    const lines = render('用 my_var_name 即可');
    assert.ok(lines[0]?.includes('my_var_name'));
  });

  it('代码栅栏:画框并保留内容', () => {
    const lines = render('```ts\nconst a = 1;\nconst b = 2;\n```');
    assert.ok(lines[0]?.startsWith('  ┌─ ts'));
    assert.ok(lines.some((line) => line.includes('const a = 1;')));
    assert.ok(lines.at(-1)?.startsWith('  └'));
  });

  it('流式中未闭合的代码栅栏按代码块渲染', () => {
    const lines = render('```python\nx = 1');
    assert.ok(lines[0]?.startsWith('  ┌─ python'));
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

  it('段内单换行保留为独立行', () => {
    const lines = render('第一点说明\n第二点说明\n第三点说明');
    assert.deepEqual(lines, ['  第一点说明', '  第二点说明', '  第三点说明']);
  });

  it('表格:全包边框、分隔行竖线对齐、列宽按渲染后内容、超宽截断', () => {
    const lines = render(
      [
        '| 场景 | 我会怎么做 |',
        '| --- | --- |',
        '| **修 bug** | 读代码 → 定位 → 改 → 测试 |',
        '| 短 | 很长很长的单元格内容远远超过列宽上限的例子内容 |',
      ].join('\n'),
      44,
    );
    // 全包:圆角顶底,与代码栅栏/输入框同一套视觉语言(前导为 markdown 缩进 + 表格缩进)
    assert.ok((lines[0] ?? '').trimStart().startsWith('┌'), '应有顶边框');
    assert.ok((lines[0] ?? '').endsWith('┐'));
    assert.ok((lines.at(-1) ?? '').trimStart().startsWith('└'), '应有底边框');
    assert.ok((lines.at(-1) ?? '').endsWith('┘'));
    // 每行宽度一致,右边框不参差
    const widths = new Set(lines.map((line) => visibleWidth(line)));
    assert.equal(widths.size, 1, `行宽不一致:${[...widths].join(',')}`);
    // ┬ ┼ ┴ 与数据行的竖线按显示列对齐(CJK 一字符两列,须按宽度展开)
    const displayCols = (line: string): Map<number, string> => {
      const map = new Map<number, string>();
      let column = 0;
      for (const char of line) {
        if (!map.has(column)) {
          map.set(column, char);
        }
        column += visibleWidth(char);
      }
      return map;
    };
    const headerCols = displayCols(stripAnsi(lines[0] ?? ''));
    const headerRowCols = displayCols(stripAnsi(lines[1] ?? ''));
    const dividerCols = displayCols(stripAnsi(lines[2] ?? ''));
    const bottomCols = displayCols(stripAnsi(lines.at(-1) ?? ''));
    const joints = [...dividerCols.entries()].filter(([, char]) => char === '┼');
    assert.ok(joints.length > 0);
    for (const [column] of joints) {
      assert.equal(headerCols.get(column), '┬', `第 ${column} 显示列 ┬ 未对准表头竖线`);
      assert.equal(headerRowCols.get(column), '│', `第 ${column} 显示列 ┼ 未对准表头竖线`);
      assert.equal(bottomCols.get(column), '┴', `第 ${column} 显示列 ┴ 未对准表底竖线`);
    }
    // 超宽单元格折行而非截断:内容完整、无省略号、行宽不超限
    assert.ok(lines.every((line) => visibleWidth(line) <= 44));
    const flattened = lines.map(stripAnsi).join('').replace(/[│\s]/g, '');
    assert.ok(flattened.includes('很长很长的单元格内容远远超过列宽上限的例子内容'));
    assert.ok(!flattened.includes('…'), '表格内容不应省略');
  });

  it('表格:折行续行保留边框,首列留空对齐', () => {
    const lines = render('| 名称 | 说明 |\n| --- | --- |\n| dev | 开发服务器,用于本地开发与热更新 |', 34);
    const text = lines.map(stripAnsi);
    // 折行后第二行的第一列为空白填充,左右边框仍在
    const wrapped = text.filter((line) => line.includes('│') && !line.includes('┌') && !line.includes('├') && !line.includes('└'));
    assert.ok(wrapped.length >= 3, `数据行应占多行:${text.join('\n')}`);
    assert.ok(text.some((line) => /│\s+│/.test(line) && line.includes('热更新')), '续行首列应留空');
    const widths = new Set(lines.map((line) => visibleWidth(line)));
    assert.equal(widths.size, 1, '所有行宽度一致');
  });

  it('表格:单横线与冒号对齐分隔行被识别', () => {
    const lines = render('| 左 | 右 |\n| :- | :-: |\n| a | b |');
    const text = lines.map(stripAnsi).join('\n');
    assert.ok(!text.includes(':-'), '对齐分隔行不应渲染为数据行');
    assert.ok(text.includes('左'));
    assert.ok(text.includes('a'));
  });

  it('__init__ 等双下划线标识符保持原样', () => {
    const lines = render('Python 里 __init__ 是构造器,__私有__ 也常见');
    const text = lines.map(stripAnsi).join('\n');
    assert.ok(text.includes('__init__'));
    assert.ok(text.includes('__私有__'));
    // ** 粗体不受影响
    assert.ok(renderMarkdown('**仍生效**', 40, theme).join('').includes('\u001b[1m'));
  });

  it('下划线斜体不吃残缺标识符,词边界外仍生效', () => {
    const eaten = render('导出 my_var_ 和 file_name 检查').map(stripAnsi).join('\n');
    assert.ok(eaten.includes('my_var_'));
    assert.ok(eaten.includes('file_name'));
    const italic = renderMarkdown('这是 _斜体内容_ 的演示', 40, theme);
    assert.ok(italic.join('').includes('\u001b[3m斜体内容\u001b[0m'));
  });

  it('有序列表多位编号的续行缩进对齐', () => {
    const lines = render('1. 第一项\n10. 第十项\n    续行与编号后文本对齐');
    const text = lines.map(stripAnsi);
    const continuation = text.find((line) => line.includes('续行与编号后文本对齐'));
    if (continuation === undefined) throw new Error('续行应存在');
    // 续行缩进 6 列(2 缩进 + "10. " 4 列)
    assert.ok(continuation.startsWith('      续行'));
  });

  it('任务列表:未完成 □、已完成 ☑', () => {
    const lines = render('- [ ] 修复登录页\n- [x] 补充单元测试\n- [X] 大写也认');
    const text = lines.map(stripAnsi).join('\n');
    assert.ok(text.includes('□ 修复登录页'));
    assert.ok(text.includes('☑ 补充单元测试'));
    assert.ok(text.includes('☑ 大写也认'));
    assert.ok(!text.includes('[ ]') && !text.includes('[x]'));
    // 已完成勾用成功色
    const styled = renderMarkdown('- [x] 完成', 40, theme).join('\n');
    assert.ok(styled.includes(`\u001b[${theme.codes.ok}m☑\u001b[0m`));
    // 有序列表里的 [x] 不是任务语法,保持原样
    assert.ok(render('1. [x] 保留').join('\n').includes('[x] 保留'));
  });

  it('裸 URL 在首个非 ASCII 字符处截断', () => {
    const segments = renderMarkdown('见 https://example.com/docs。然后继续。', 60, theme);
    const styled = segments.join('\n');
    assert.ok(styled.includes('https://example.com/docs'));
    // 句号与后续正文不带链接样式:直接检查行内文本的组成
    const line = segments[2] ?? '';
    assert.ok(!line.includes('\u001b[4m'), '句号不应是链接');
  });

  it('表格对齐语义 :-: 居中、---: 右对齐', () => {
    const lines = render('| 名称 | 数量 |\n| :--- | ---: |\n| 总计 | 42 |', 40);
    const text = lines.map(stripAnsi);
    const numberRow = text.find((line) => line.includes('42'));
    if (numberRow === undefined) throw new Error('数据行应存在');
    // 右对齐:42 靠向右侧竖线
    assert.ok(/│\s+42 │$/.test(numberRow), numberRow);
    // 居中:列宽 4、内容 2,两侧各留 1 格
    const centered = render('| 名称 |\n| :-: |\n| ab |', 40).map(stripAnsi).join('\n');
    assert.ok(centered.includes('│  ab  │'), centered);
  });

  it('尖括号自动链接去掉括号', () => {
    const lines = render('参考 <https://example.com/a> 说明');
    const text = lines.map(stripAnsi).join('\n');
    assert.ok(text.includes('https://example.com/a'));
    assert.ok(!text.includes('<https'));
  });

  it('带空格的分隔线 * * * 与 - - -', () => {
    const text = render('上面\n\n* * *\n\n下面').map(stripAnsi).join('\n');
    assert.ok(text.includes('──'), '应渲染为横线');
    assert.ok(!text.includes('•'), '不应被当成列表');
    assert.ok(render('- - -').some((line) => /^  ─+$/.test(line)));
  });

  it('流式中间态:孤立表格行原样渲染,不卡死', () => {
    // 表头行已到、分隔行未到时,该行匹配段落排除条件但不属于任何块,
    // 曾导致渲染循环原地打转、整 TUI 冻结
    const orphan = render('| 脚本名 | 命令 |').map(stripAnsi).join('\n');
    assert.ok(orphan.includes('| 脚本名 | 命令 |'), '孤立行应原样保留');
    assert.ok(render('| --- |').map(stripAnsi).join('\n').includes('| --- |'));
    // 表格后续帧(分隔行到达)恢复为正常表格
    assert.ok(render('| a | b |\n| --- |').some((line) => line.includes('┌')));
  });

  it('流式逐前缀扫描:含表格/列表/引用/栅栏的文档每一帧都可渲染', () => {
    const full = [
      '好的,给你一个表格:',
      '',
      '| 脚本名 | 命令 | 说明 |',
      '| --- | --- | --- |',
      '| dev | vite | 开发服务器 |',
      '',
      '- [ ] 待办一',
      '- [x] 待办二',
      '',
      '> 引用一段',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '* * *',
      '',
      '结束。',
    ].join('\n');
    // 逐字符推进前缀,覆盖流式输出可能出现的每一个中间态
    for (let end = 1; end <= full.length; end += 1) {
      renderMarkdown(full.slice(0, end), 50, theme);
    }
    assert.ok(true, '全程无卡死即通过');
  });

  it('代码围栏内的同类标记行不提前闭合', () => {
    // 内层 ```js 只是内容:按前缀判断会在这里提前闭合,把后面的代码排成正文
    const lines = render(['```md', '```js', 'const x = 1;', '```'].join('\n'), 40);
    const codeLines = lines.filter((line) => /```js|const x = 1;/.test(line));
    assert.equal(codeLines.length, 2);
    assert.ok(codeLines.every((line) => line.includes('│')), codeLines.join('\n'));
  });

  it('标题取 markdown 组的 heading 角色,不借用 TUI 的 accent', () => {
    // 两个角色当前取值相同,直接看渲染结果分不出来;用取值不同的替身主题验证归属
    const base = createTheme({ color: true });
    const stub = { ...base, codes: { ...base.codes, heading: '38;5;9', accent: '38;5;10' } };
    const styled = renderMarkdown('# 标题', 40, stub).join('\n');
    assert.ok(styled.includes('\u001b[38;5;9m'), '标题应取 heading 角色');
    assert.equal(styled.includes('\u001b[38;5;10m'), false, '标题不应取 accent');
  });
});
