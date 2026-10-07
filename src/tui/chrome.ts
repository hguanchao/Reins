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
    top: theme.paint.muted(`┌${dashes}┐`),
    bottom: theme.paint.muted(`└${dashes}┘`),
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
