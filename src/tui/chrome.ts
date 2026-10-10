import { fitPlain, padAnsi, paintRow, truncatePlain, visibleWidth } from './layout.ts';
import type { TuiKey } from './keys.ts';
import type { Theme } from './theme.ts';

/**
 * 界面镶边:输入框边框与滚动条的排版数学。
 *
 * 设计意图:与 layout 同样的纯函数思路,但镶边依赖主题取色;
 * 应用层只负责拼装内容,画框与几何全部在这里算,便于单测。
 */

/** 输入框上沿与下沿,占满整行宽度。 */
export function inputBoxFrame(
  width: number,
  theme: Theme,
  focused = true,
): { top: string; bottom: string } {
  const dashes = '─'.repeat(Math.max(0, width - 2));
  const paintBorder = focused ? theme.paint.muted : theme.paint.completionBorder;
  return {
    top: paintBorder(`╭${dashes}╮`),
    bottom: paintBorder(`╰${dashes}╯`),
  };
}

/** 输入框内容行:两侧竖线夹住,内容补齐空格保证右缘对齐。 */
export function inputBoxLine(content: string, width: number, theme: Theme, focused = true): string {
  const paintBorder = focused ? theme.paint.muted : theme.paint.completionBorder;
  return `${paintBorder('│')} ${padAnsi(content, Math.max(0, width - 4))} ${paintBorder('│')}`;
}

/** 审批选项横向渲染:当前项使用与输入框相同的提示符。 */
export function renderApprovalOptions(options: readonly string[], selected: number, theme: Theme): string {
  return options
    .map((option, index) => `${index === selected ? theme.paint.accent('› ') : '  '}${option}`)
    .join('   ');
}

/** 审批选项个数:允许 / 本会话总是允许 / 拒绝。 */
export const APPROVAL_OPTION_COUNT = 3;

/**
 * 审批选项的左右切换:返回新的选中下标,undefined 表示该键不改变选中项。
 *
 * 选项是横排的,所以只有左右参与切换;上下不响应,免得与输入框的历史、
 * 光标移动混在一起——审批是模态的,按错键比没反应更糟。
 */
export function moveApprovalIndex(key: TuiKey, index: number): number | undefined {
  if (key.type === 'left') {
    return (index + APPROVAL_OPTION_COUNT - 1) % APPROVAL_OPTION_COUNT;
  }
  if (key.type === 'right') {
    return (index + 1) % APPROVAL_OPTION_COUNT;
  }
  return undefined;
}

/** 给输入框首行的斜杠命令着色,参数与普通文本保持原样。 */
export function paintSlashCommand(text: string, paint: (value: string) => string): string {
  if (!text.startsWith('/')) {
    return text;
  }
  const end = text.search(/[\s]/);
  const commandEnd = end === -1 ? text.length : end;
  return `${paint(text.slice(0, commandEnd))}${text.slice(commandEnd)}`;
}

/** 输入框在终端中的 1 基行范围,包含上下边框。 */
export function inputBoxRowRange(mainHeight: number, inputLineCount: number): { top: number; bottom: number } {
  const top = Math.max(1, mainHeight + 1);
  return { top, bottom: top + Math.max(0, inputLineCount) + 1 };
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

/** 滚动条第 index 行的区域:滑块或轨道。 */
export function scrollbarChar(
  index: number,
  geometry: ScrollbarGeometry,
): 'thumb' | 'track' {
  return index >= geometry.thumbStart && index < geometry.thumbStart + geometry.thumbSize
    ? 'thumb'
    : 'track';
}

/** 绘制滚动条一行:滑块着色,轨道留空以免出现竖线。 */
export function renderScrollbarLine(
  index: number,
  geometry: ScrollbarGeometry | undefined,
  theme: Theme,
): string {
  if (geometry === undefined || scrollbarChar(index, geometry) === 'track') {
    return ' ';
  }
  return theme.paint.scrollbar('█');
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

/** 将菜单覆盖到内容区底部,并可保留每行最右侧的滚动条列。 */
export function overlayLines(
  base: readonly string[],
  overlay: readonly string[],
  rightColumn: readonly string[] = [],
): string[] {
  const lines = [...base];
  const count = Math.min(base.length, overlay.length);
  const baseStart = base.length - count;
  const overlayStart = overlay.length - count;
  for (let offset = 0; offset < count; offset += 1) {
    const row = baseStart + offset;
    const edge = rightColumn[row] ?? '';
    const width = Math.max(0, visibleWidth(base[row] ?? '') - visibleWidth(edge));
    lines[row] = `${padAnsi(overlay[overlayStart + offset] ?? '', width)}${edge}`;
  }
  return lines;
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
 * 渲染补全菜单:候选区行数固定,选中项始终落在窗口内。
 *
 * 候选不足时补空行,上下各加一条浅灰横线;背景铺满候选区,避免覆盖主区时露出底色。
 * 主文本与次要文本分两列,次要列对齐;两段各自按可用宽度截断,长路径不会撑破边框。
 */
export function completionMenu(
  rows: readonly MenuRow[],
  selected: number,
  width: number,
  theme: Theme,
  height: number = COMPLETION_MENU_ROWS,
): string[] {
  // 主次两列之间留 12 格:说明与路径离标签太近会显得挤,留出呼吸感也更好扫读
  const labelColumn = Math.min(
    rows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0) + 12,
    Math.max(0, width - 6),
  );
  const detailRoom = Math.max(0, width - 4 - labelColumn);
  const start = windowStart(selected, rows.length, height);
  const out = [theme.paint.completionBorder('─'.repeat(Math.max(0, width)))];
  for (let offset = 0; offset < height; offset += 1) {
    const row = rows[start + offset];
    if (row === undefined) {
      out.push(paintRow('', width, theme.codes.completionBg));
      continue;
    }
    const label = fitPlain(row.label, labelColumn);
    const detail = truncatePlain(row.detail ?? '', detailRoom);
    // 没有次要文本时不产生空的样式序列
    const tail = detail === '' ? '' : theme.paint.muted(detail);
    const line =
      start + offset === selected
        ? `  ${theme.paint.accent('› ')}${theme.paint.accent(label)}${tail}`
        : theme.paint.muted(`    ${label}${detail}`);
    out.push(paintRow(line, width, theme.codes.completionBg));
  }
  out.push(theme.paint.completionBorder('─'.repeat(Math.max(0, width))));
  return out;
}
