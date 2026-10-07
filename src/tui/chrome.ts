import { padAnsi, truncateAnsi, visibleWidth } from './layout.ts';
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
