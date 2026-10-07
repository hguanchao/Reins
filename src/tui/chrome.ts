import { fitPlain, padAnsi, truncateAnsi, truncatePlain, visibleWidth } from './layout.ts';
import type { Theme } from './theme.ts';

/**
 * 界面镶边:header 行、输入框边框与滚动条的排版数学。
 *
 * 设计意图:与 layout 同样的纯函数思路,但镶边依赖主题取色;
 * 应用层只负责拼装内容,画框与几何全部在这里算,便于单测。
 */

/**
 * header 行:左侧信息与右侧统计两端对齐,无边框装饰。
 * 空间不足时右侧统计优先保留,左侧截断。
 */
export function headerLine(left: string, right: string, width: number, theme: Theme): string {
  void theme;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (rightWidth === 0) {
    return truncateAnsi(left, width);
  }
  if (leftWidth + rightWidth + 1 <= width) {
    return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
  }
  const allowLeft = Math.max(0, width - rightWidth - 1);
  const leftText = allowLeft > 0 ? truncateAnsi(left, allowLeft) : '';
  return `${leftText}${' '.repeat(Math.max(1, width - visibleWidth(leftText) - rightWidth))}${right}`;
}

/** 输入框上沿与下沿,占满整行宽度。 */
export function inputBoxFrame(width: number, theme: Theme): { top: string; bottom: string } {
  const dashes = '─'.repeat(Math.max(0, width - 2));
  return {
    top: theme.paint.muted(`╭${dashes}╮`),
    bottom: theme.paint.muted(`╰${dashes}╯`),
  };
}

/** 输入框内容行:两侧竖线夹住,内容补齐空格保证右缘对齐。 */
export function inputBoxLine(content: string, width: number, theme: Theme): string {
  return `${theme.paint.muted('│')} ${padAnsi(content, Math.max(0, width - 4))} ${theme.paint.muted('│')}`;
}

export interface ScrollbarGeometry {
  thumbStart: number;
  thumbSize: number;
}

/**
 * 滚动条几何:内容不超出视口时返回 undefined(不画)。
 * 滑块大小按「视口/内容」比例,位置按滚动进度映射到可滑动行程。
 */
export function scrollbarGeometry(
  top: number,
  viewHeight: number,
  contentHeight: number,
): ScrollbarGeometry | undefined {
  if (viewHeight <= 0 || contentHeight <= viewHeight) {
    return undefined;
  }
  const thumbSize = Math.max(1, Math.round((viewHeight / contentHeight) * viewHeight));
  const travel = Math.max(0, viewHeight - thumbSize);
  const maxTop = contentHeight - viewHeight;
  const thumbStart = Math.min(travel, Math.max(0, Math.round((top / maxTop) * travel)));
  return { thumbStart, thumbSize };
}

/** 滚动条第 index 行的字符:滑块 █ / 轨道 │,由调用方决定取色。 */
export function scrollbarChar(
  index: number,
  geometry: ScrollbarGeometry,
): 'thumb' | 'track' {
  return index >= geometry.thumbStart && index < geometry.thumbStart + geometry.thumbSize
    ? 'thumb'
    : 'track';
}

/**
 * 把内容在给定高度内垂直居中,上下用空行补齐。
 *
 * 只用于「欢迎面板独占屏幕」这类静态单块内容:对话开始后内容自上而下增长,
 * 再居中会让最新一行随长度跳动,反而不好找。
 */
export function centerVertically(lines: readonly string[], height: number): string[] {
  const pad = Math.floor((height - lines.length) / 2);
  if (pad <= 0) {
    return [...lines];
  }
  return [...Array.from({ length: pad }, () => ''), ...lines];
}

/** 补全菜单的一行:主文本 + 次要文本(命令说明或文件所在目录)。 */
export interface MenuRow {
  label: string;
  detail?: string;
}

/** 补全菜单的常规行数:高度固定,输入框才不会随候选多少上下跳动。 */
export const COMPLETION_MENU_ROWS = 8;

/**
 * 相对路径拆成「名称 + 所在目录」,根目录下的条目没有目录部分。
 *
 * 目录项以 '/' 结尾,拆出的名称保留这个尾斜杠:菜单里一眼能看出是可下钻的目录。
 */
export function splitPathLabel(path: string): MenuRow {
  const isDir = path.endsWith('/');
  const body = isDir ? path.slice(0, -1) : path;
  const cut = body.lastIndexOf('/');
  const name = cut === -1 ? body : body.slice(cut + 1);
  const label = isDir ? `${name}/` : name;
  return cut === -1 ? { label } : { label, detail: body.slice(0, cut) };
}

/** 固定高度窗口的起始下标:选中项尽量居中,两端不越界。 */
function windowStart(selected: number, total: number, height: number): number {
  if (total <= height) {
    return 0;
  }
  const half = Math.floor(height / 2);
  return Math.max(0, Math.min(selected - half, total - height));
}

/**
 * 下拉窗口:候选行数按上限裁剪,起始下标让选中项尽量居中且不出界。
 *
 * 渲染与鼠标命中测试共用它——两处各算一遍窗口,滚到第 9 条分支时就会点对行。
 */
export function branchWindow(
  total: number,
  selected: number,
  limit: number = COMPLETION_MENU_ROWS,
): { start: number; rows: number } {
  const rows = Math.max(1, Math.min(limit, total));
  return { start: windowStart(selected, total, rows), rows };
}

/**
 * 分支下拉:一行提示 + 固定上限的候选项,选中项带 ›,当前分支带标记。
 *
 * 与补全菜单同一套视觉语言:不加边框,靠选中色区分层级。
 */
export function branchDropdown(
  items: readonly string[],
  selected: number,
  current: string | undefined,
  width: number,
  theme: Theme,
  limit: number = COMPLETION_MENU_ROWS,
): string[] {
  const { start, rows } = branchWindow(items.length, selected, limit);
  const window = items.slice(start, start + rows);
  // 列宽取窗口内最宽的分支名,再按可用空间封顶:取 min 会把长名字截成省略号
  const widest = window.reduce((max, name) => Math.max(max, visibleWidth(name)), 0);
  const nameWidth = Math.max(0, Math.min(width - 8, widest));
  const lines = [theme.paint.muted('  ↑↓ 选择 · Enter 切换 · Esc 关闭')];
  for (let offset = 0; offset < rows; offset += 1) {
    const name = window[offset];
    if (name === undefined) {
      continue;
    }
    const label = truncatePlain(name, nameWidth);
    const tail = name === current ? theme.paint.muted('  当前') : '';
    lines.push(
      start + offset === selected
        ? `  ${theme.paint.accent('› ')}${theme.paint.accent(label)}${tail}`
        : `    ${theme.paint.muted(label)}${tail}`,
    );
  }
  // 每行都收进给定宽度:提示行在窄终端里同样不能越过右缘
  return lines.map((line) => truncateAnsi(line, width));
}

/**
 * 渲染补全菜单:行数固定,选中项始终落在窗口内。
 *
 * 行数固定是为了输入框不随候选多少上下跳动;候选不足时补空行。
 * 主文本与次要文本分两列,次要列对齐;两段各自按可用宽度截断,长路径不会撑破边框。
 */
export function completionMenu(
  rows: readonly MenuRow[],
  selected: number,
  width: number,
  theme: Theme,
  height: number = COMPLETION_MENU_ROWS,
): string[] {
  const labelColumn = Math.min(
    rows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0) + 2,
    Math.max(0, width - 6),
  );
  const detailRoom = Math.max(0, width - 4 - labelColumn);
  const start = windowStart(selected, rows.length, height);
  const out: string[] = [];
  for (let offset = 0; offset < height; offset += 1) {
    const row = rows[start + offset];
    if (row === undefined) {
      out.push('');
      continue;
    }
    const label = fitPlain(row.label, labelColumn);
    const detail = truncatePlain(row.detail ?? '', detailRoom);
    // 没有次要文本时不产生空的样式序列
    const tail = detail === '' ? '' : theme.paint.muted(detail);
    out.push(
      start + offset === selected
        ? `  ${theme.paint.accent('› ')}${theme.paint.accent(label)}${tail}`
        : theme.paint.muted(`    ${label}${detail}`),
    );
  }
  return out;
}
