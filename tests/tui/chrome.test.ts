import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  branchDropdown,
  branchWindow,
  centerVertically,
  COMPLETION_MENU_ROWS,
  completionMenu,
  headerLine,
  inputBoxFrame,
  inputBoxLine,
  scrollbarChar,
  scrollbarGeometry,
  splitPathLabel,
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
    assert.equal(stripAnsi(top), `╭${'─'.repeat(38)}╮`);
    assert.equal(stripAnsi(bottom), `╰${'─'.repeat(38)}╯`);
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

describe('垂直居中', () => {
  it('上方补空行,下方由主区补满', () => {
    assert.deepEqual(centerVertically(['a', 'b'], 6), ['', '', 'a', 'b']);
    assert.deepEqual(centerVertically(['a'], 4), ['', 'a']);
    assert.deepEqual(centerVertically(['a'], 5), ['', '', 'a']);
  });

  it('内容不低于容器时原样返回', () => {
    assert.deepEqual(centerVertically(['a', 'b', 'c'], 3), ['a', 'b', 'c']);
    assert.deepEqual(centerVertically(['a', 'b', 'c'], 1), ['a', 'b', 'c']);
    // 空内容只补一行空行,不抛错
    assert.deepEqual(centerVertically([], 3), ['']);
  });
});

describe('补全菜单', () => {
  const rows = [
    { label: '/help', detail: '显示帮助' },
    { label: '/new', detail: '开始新会话' },
    { label: '/resume', detail: '恢复会话;无 id 时列出' },
  ];

  it('高度固定:候选不足时补空行', () => {
    const menu = completionMenu(rows, 0, 60, theme, 5);
    assert.equal(menu.length, 5);
    assert.equal(menu[3], '');
    assert.equal(menu[4], '');
  });

  it('主次两列:次要文本对齐到同一列', () => {
    const menu = completionMenu(rows, 0, 60, theme, 3).map(stripAnsi);
    assert.ok(menu[0]?.startsWith('  › /help  '), menu[0]);
    const column = menu[0]?.indexOf('显示帮助');
    assert.equal(menu[1]?.indexOf('开始新会话'), column);
    assert.equal(menu[2]?.indexOf('恢复会话;无 id 时列出'), column);
  });

  it('候选超出高度时选中项始终落在窗口内', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ label: `/cmd${index}` }));
    for (const selected of [0, 5, 12, 19]) {
      const menu = completionMenu(many, selected, 60, theme, 8);
      const active = menu.findIndex((line) => stripAnsi(line).includes('›'));
      assert.ok(active >= 0, `选中项 ${selected} 不在窗口内`);
      assert.ok(stripAnsi(menu[active] ?? '').includes(`/cmd${selected}`));
    }
  });

  it('长路径按宽度截断,不撑破边框', () => {
    const long = [{ label: 'a-very-long-file-name.ts', detail: 'some/deeply/nested/directory/path' }];
    for (const width of [20, 30, 40]) {
      for (const line of completionMenu(long, 0, width, theme, 2)) {
        assert.ok(visibleWidth(line) <= width, `宽${width} 超宽:${stripAnsi(line)}`);
      }
    }
  });

  it('splitPathLabel:拆出文件名与所在目录', () => {
    assert.deepEqual(splitPathLabel('src/tui/app.ts'), { label: 'app.ts', detail: 'src/tui' });
    // 根目录下的文件没有目录部分
    assert.deepEqual(splitPathLabel('README.md'), { label: 'README.md' });
  });

  it('splitPathLabel:目录项保留尾斜杠,一眼看出可下钻', () => {
    assert.deepEqual(splitPathLabel('src/tui/'), { label: 'tui/', detail: 'src' });
    assert.deepEqual(splitPathLabel('src/'), { label: 'src/' });
  });
});

describe('分支下拉', () => {
  const items = Array.from({ length: 12 }, (_unused, index) => `branch-${index + 1}`);

  it('首行是按键提示,其后是候选:选中带 ›、当前分支带标记', () => {
    const lines = branchDropdown(items, 0, 'branch-1', 40, theme).map(stripAnsi);
    assert.equal(lines.length, 1 + COMPLETION_MENU_ROWS);
    assert.ok(lines[0]?.includes('Enter 切换'));
    assert.ok(lines[1]?.includes('› branch-1'));
    assert.ok(lines[1]?.includes('当前'));
  });

  it('候选不足时按实际条数,不留空行', () => {
    assert.equal(branchDropdown(['main', 'dev'], 0, 'main', 40, theme).length, 1 + 2);
  });

  it('超过上限时窗口随选中项滑动,选中项始终在屏内', () => {
    const text = branchDropdown(items, 11, undefined, 40, theme).map(stripAnsi).join('\n');
    assert.ok(text.includes('branch-12'), '选中项要出现在窗口内');
    assert.equal(text.includes('branch-4'), false, '窗口外的旧项不该留在下拉里');
  });

  it('branchWindow 的行数与起始下标不会越界', () => {
    assert.deepEqual(branchWindow(3, 0), { start: 0, rows: 3 });
    const moved = branchWindow(50, 49);
    assert.equal(moved.rows, COMPLETION_MENU_ROWS);
    assert.ok(moved.start + moved.rows <= 50);
  });

  it('窄终端下每行都不越过右缘', () => {
    for (const line of branchDropdown(['feature/一个很长很长的分支名'], 0, undefined, 18, theme)) {
      assert.ok(visibleWidth(line) <= 18, `超宽:${stripAnsi(line)}`);
    }
  });
});
