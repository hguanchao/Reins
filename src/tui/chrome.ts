import { padAnsi, truncateAnsi, visibleWidth } from './layout.ts';
import type { Theme } from './theme.ts';

/**
 * 界面镶边:header 置顶带、输入框边框与滚动条的排版数学。
 *
 * 设计意图:与 layout 同样的纯函数思路,但镶边依赖主题取色;
 * 应用层只负责拼装内容,画框与几何全部在这里算,便于单测。
 */

/**
 * header 置顶带:内容嵌进顶边框(┌─ 内容 ─┐),下沿以 ├─┤ 接缝收束。
 * 返回恰好两行,占用行数与普通「文本 + 分隔线」相同。
 */
export function headerBand(
  left: string,
  right: string,
  width: number,
  theme: Theme,
): { top: string; join: string } {
  const join = theme.paint.muted(`├${'─'.repeat(Math.max(0, width - 2))}┤`);
  const budget = width - 6; // 「┌─ 」与「 ─┐」各占 3 列
  if (budget < 8) {
    // 极窄时放弃嵌内容,退化为纯边框
    return { top: theme.paint.muted(`┌${'─'.repeat(Math.max(0, width - 2))}┐`), join };
  }

  let rightText = right;
  let rightWidth = visibleWidth(rightText);
  // 右侧统计信息优先保证完整,放不下先截右边
  if (rightWidth > budget - 4) {
    rightText = truncateAnsi(rightText, Math.max(0, budget - 4));
    rightWidth = visibleWidth(rightText);
  }
  let leftText = left;
  if (visibleWidth(leftText) + rightWidth > budget - 3) {
    const allowLeft = Math.max(0, budget - rightWidth - 3);
    leftText = allowLeft > 0 ? truncateAnsi(leftText, allowLeft) : '';
  }
  const gap = Math.max(2, budget - visibleWidth(leftText) - rightWidth);
  const dashes = theme.paint.muted('─'.repeat(gap));
  const middle =
    rightText === ''
      ? `${leftText}${theme.paint.muted('─'.repeat(Math.max(2, budget - visibleWidth(leftText))))}`
      : `${leftText}${dashes}${rightText}`;
  return {
    top: `${theme.paint.muted('┌─ ')}${middle}${theme.paint.muted(' ─┐')}`,
    join,
  };
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
