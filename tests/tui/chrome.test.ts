import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  centerVertically,
  completionMenu,
  inputBoxFrame,
  inputBoxLine,
  inputBoxRowRange,
  moveApprovalIndex,
  movePickerIndex,
  overlayLines,
  paintSlashCommand,
  prefixRemainder,
  renderApprovalOptions,
  renderScrollbarLine,
  scrollbarChar,
  scrollbarGeometry,
  splitPathLabel,
} from '../../src/tui/chrome.ts';
import { createTheme } from '../../src/tui/theme.ts';
import { stripAnsi, visibleWidth } from '../../src/tui/layout.ts';

const theme = createTheme({ color: true });

describe('输入框边框', () => {
  it('上下沿占满整行,聚焦时使用原边框色', () => {
    const { top, bottom } = inputBoxFrame(40, theme);
    assert.equal(stripAnsi(top), `╭${'─'.repeat(38)}╮`);
    assert.equal(stripAnsi(bottom), `╰${'─'.repeat(38)}╯`);
    assert.ok(top.startsWith(`\u001b[${theme.codes.muted}m`));
    assert.ok(bottom.startsWith(`\u001b[${theme.codes.muted}m`));
    assert.ok(inputBoxLine('› 你好', 40, theme).startsWith(`\u001b[${theme.codes.muted}m`));
  });

  it('失焦时边框改为 #242424,内容宽度保持不变', () => {
    const frame = inputBoxFrame(40, theme, false);
    assert.ok(frame.top.startsWith(`\u001b[${theme.codes.completionBorder}m`));
    assert.ok(frame.bottom.startsWith(`\u001b[${theme.codes.completionBorder}m`));
    const line = inputBoxLine('› 你好', 40, theme, false);
    const plain = stripAnsi(line);
    assert.ok(plain.startsWith('│ › 你好'));
    assert.ok(plain.endsWith('│'));
    assert.ok(line.startsWith(`\u001b[${theme.codes.completionBorder}m`));
    assert.equal(visibleWidth(line), 40);
  });

  it('计算输入框在终端中的行范围', () => {
    assert.deepEqual(inputBoxRowRange(18, 3), { top: 19, bottom: 23 });
  });

  it('审批选项横向排列并用 › 标记当前项', () => {
    const options = renderApprovalOptions(['[y] 允许', '[a] 始终允许', '[n] 拒绝'], 1, theme);
    assert.ok(options.includes(`\u001b[${theme.codes.accent}m› `));
    assert.equal(stripAnsi(options), '  [y] 允许   › [a] 始终允许     [n] 拒绝');
  });

  it('审批选项只用左右切换,且到两端停住不回环', () => {
    assert.equal(moveApprovalIndex({ type: 'right' }, 0), 1);
    assert.equal(moveApprovalIndex({ type: 'right' }, 2), 2);
    assert.equal(moveApprovalIndex({ type: 'left' }, 0), 0);
    assert.equal(moveApprovalIndex({ type: 'left' }, 2), 1);
  });

  it('审批卡片上上下键、回车与文字键都不切换选项', () => {
    for (const type of ['up', 'down', 'enter', 'escape', 'tab'] as const) {
      assert.equal(moveApprovalIndex({ type }, 1), undefined, `${type} 不该切换选项`);
    }
    assert.equal(moveApprovalIndex({ type: 'text', text: 'y' }, 1), undefined);
  });

  it('命令子菜单用上下选择,到两端停住不回环', () => {
    assert.equal(movePickerIndex({ type: 'down' }, 0, 3), 1);
    assert.equal(movePickerIndex({ type: 'up' }, 0, 3), 0);
    assert.equal(movePickerIndex({ type: 'down' }, 2, 3), 2);
    for (const type of ['left', 'right', 'enter', 'escape', 'tab'] as const) {
      assert.equal(movePickerIndex({ type }, 1, 3), undefined, `${type} 不该切换选中项`);
    }
  });

  it('参数行尾预选:补出首个前缀命中的剩余部分', () => {
    const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.equal(prefixRemainder(levels, 'x'), 'high');
    assert.equal(prefixRemainder(levels, 'h'), 'igh');
    assert.equal(prefixRemainder(levels, 'me'), 'dium');
    // 已完整匹配、空串、无命中都无增量可补
    assert.equal(prefixRemainder(levels, 'xhigh'), undefined);
    assert.equal(prefixRemainder(levels, ''), undefined);
    assert.equal(prefixRemainder(levels, 'z'), undefined);
  });

  it('斜杠命令着色但不影响参数与显示宽度', () => {
    const paint = theme.paint.accent;
    const command = paintSlashCommand('/help', paint);
    const withArgs = paintSlashCommand('/help 参数', paint);
    const plain = paintSlashCommand('普通文本', paint);
    assert.equal(command, `${paint('/help')}`);
    assert.equal(withArgs, `${paint('/help')} 参数`);
    assert.equal(plain, '普通文本');
    assert.equal(visibleWidth(withArgs), visibleWidth('/help 参数'));
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

  it('滑块使用用户消息背景色,轨道不绘制竖线', () => {
    const geometry = scrollbarGeometry(0, 4, 8);
    if (geometry === undefined) throw new Error('应显示滚动条');
    assert.equal(renderScrollbarLine(0, geometry, theme), `\u001b[${theme.codes.scrollbar}m█\u001b[0m`);
    assert.equal(renderScrollbarLine(3, geometry, theme), ' ');
    assert.equal(renderScrollbarLine(0, undefined, theme), ' ');
  });
});

describe('覆盖菜单', () => {
  it('覆盖内容区底部但不改变行数和顶部内容', () => {
    const base = ['上方'.padEnd(20), '中间'.padEnd(20), '底部'.padEnd(20), '输入框'.padEnd(20)];
    const result = overlayLines(base, ['菜单一', '菜单二']);
    assert.equal(result.length, base.length);
    assert.deepEqual(result.slice(0, 2), base.slice(0, 2));
    assert.ok(result[2]?.startsWith('菜单一'));
    assert.ok(result[3]?.startsWith('菜单二'));
  });

  it('保留滚动条列并按空间限制覆盖行数', () => {
    const base = ['123456789│', 'abcdefghij█'];
    const result = overlayLines(base, ['menu one', 'menu two', 'menu three'], ['│', '█']);
    assert.equal(result.length, base.length);
    assert.deepEqual(result, ['menu two │', 'menu three█']);
  });

  it('菜单行为空时仍擦除底层内容', () => {
    const result = overlayLines(['历史内容', '底部'], ['', '菜单']);
    assert.deepEqual(result, [' '.repeat(visibleWidth('历史内容')), '菜单']);
  });

  it('无覆盖内容时返回原行', () => {
    const base = ['一', '二'];
    assert.deepEqual(overlayLines(base, []), base);
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
    { label: '/model', detail: '查看或切换模型' },
    { label: '/effort', detail: '查看或切换思考强度' },
  ];

  it('上下有浅灰边框,候选区铺灰色背景且高度固定', () => {
    const menu = completionMenu(rows, 0, 60, theme, 5);
    assert.equal(menu.length, 7);
    assert.equal(menu[0], theme.paint.completionBorder('─'.repeat(60)));
    assert.equal(menu[6], theme.paint.completionBorder('─'.repeat(60)));
    assert.equal(stripAnsi(menu[4] ?? ''), ' '.repeat(60));
    assert.ok(menu[4]?.startsWith(`\u001b[${theme.codes.completionBg}m`));
    assert.ok(menu[4]?.endsWith('\u001b[0m'));
  });

  it('主次两列:次要文本对齐到同一列', () => {
    const menu = completionMenu(rows, 0, 60, theme, 3).map(stripAnsi);
    assert.ok(menu[1]?.startsWith('  › /help  '), menu[1]);
    const column = menu[1]?.indexOf('显示帮助');
    assert.equal(menu[2]?.indexOf('查看或切换模型'), column);
    assert.equal(menu[3]?.indexOf('查看或切换思考强度'), column);
  });

  it('候选超出高度时选中项始终落在窗口内', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ label: `/cmd${index}` }));
    for (const selected of [0, 5, 12, 19]) {
      const menu = completionMenu(many, selected, 60, theme, 8);
      const active = menu.findIndex((line) => stripAnsi(line).includes('›'));
      assert.ok(active >= 1, `选中项 ${selected} 不在窗口内`);
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
