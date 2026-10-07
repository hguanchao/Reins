/**
 * TUI 布局:宽度计算(含 CJK 双宽)、截断、填充与折行。
 *
 * 设计意图:终端排版的一切数学集中于此,纯函数、可单测;
 * 中英文混排必须按显示宽度而非字符数计算。
 */

import { sgr } from '../util/ansi.ts';

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** 去掉 ANSI 样式序列。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** 单个码点的显示宽度:东亚宽字符为 2,控制字符为 0,其余为 1。 */
export function codePointWidth(codePoint: number): number {
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  // 零宽字符:组合附加符号、零宽连接/断字、方向标记、文本变体选择符、变体选择符补充
  if (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfe0e ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }
  // VS16 把前一个字符切换成 emoji 呈现,多占一列;配 SMP emoji 会多算 1,
  // 宁可多算(行画短、右缘留缝)也不少算(行画超宽、挤换行破坏整帧)
  if (codePoint === 0xfe0f) {
    return 1;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  // emoji:补充平面各表情区块与 BMP 上默认即 emoji 呈现的符号,
  // 终端普遍按双宽渲染,漏算会把行挤到换行、破坏帧差分
  if (
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  if (inRanges(codePoint, EMOJI_PRESENTATION_BMP)) {
    return 2;
  }
  return 1;
}

/** BMP 上默认以 emoji 呈现(双宽)的符号区间。 */
const EMOJI_PRESENTATION_BMP: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b],
  [0x23ce, 0x23ce],
  [0x23e9, 0x23f3],
  [0x23f8, 0x23fa],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x2b05, 0x2b07],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** 文本的显示宽度(忽略 ANSI 样式)。 */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/** 截断纯文本到指定显示宽度;超长时以省略号结尾。 */
export function truncatePlain(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (visibleWidth(text) <= width) {
    return text;
  }
  let out = '';
  let used = 0;
  const limit = Math.max(0, width - 1);
  for (const char of text) {
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + charWidth > limit) {
      break;
    }
    out += char;
    used += charWidth;
  }
  return `${out}…`;
}

/** 截断并补齐空格到指定显示宽度。 */
export function fitPlain(text: string, width: number): string {
  const cut = truncatePlain(text, width);
  const pad = width - visibleWidth(cut);
  return pad > 0 ? cut + ' '.repeat(pad) : cut;
}

/** 截断带 ANSI 样式的文本到指定显示宽度;保留样式序列。 */
export function truncateAnsi(text: string, width: number): string {
  if (visibleWidth(text) <= width) {
    return text;
  }
  let out = '';
  let used = 0;
  const limit = Math.max(0, width - 1);
  let index = 0;
  while (index < text.length) {
    const escape = /^\u001b\[[0-9;]*m/.exec(text.slice(index));
    if (escape !== null) {
      out += escape[0];
      index += escape[0].length;
      continue;
    }
    const codePoint = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const charWidth = codePointWidth(codePoint);
    if (used + charWidth > limit) {
      break;
    }
    out += char;
    used += charWidth;
    index += char.length;
  }
  return `${out}…\u001b[0m`;
}

/** 把带样式的行补齐空格到指定显示宽度;超宽时按样式截断。 */
export function padAnsi(text: string, width: number): string {
  const used = visibleWidth(text);
  if (used >= width) {
    return truncateAnsi(text, width);
  }
  return text + ' '.repeat(width - used);
}

/** 折行:优先在空格处断行,中文等无空格文本按宽度硬折。 */
export function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) {
    return [''];
  }
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    let lastSpace = -1;
    const flush = (): void => {
      lines.push(current);
      current = '';
      currentWidth = 0;
      lastSpace = -1;
    };
    for (const char of paragraph) {
      const charWidth = codePointWidth(char.codePointAt(0) ?? 0);
      if (charWidth === 0) {
        continue;
      }
      if (currentWidth + charWidth > width) {
        if (lastSpace >= 0 && lastSpace > 0) {
          const rest = current.slice(lastSpace + 1) + char;
          current = current.slice(0, lastSpace);
          flush();
          current = rest;
          currentWidth = visibleWidth(rest);
        } else {
          flush();
          current = char;
          currentWidth = charWidth;
        }
      } else {
        current += char;
        currentWidth += charWidth;
      }
      if (char === ' ') {
        lastSpace = current.length - 1;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** 带样式的最小排版单元:codes 为 SGR 码串,空串表示无样式。 */
export interface StyledSegment {
  text: string;
  codes: string;
}

/** 把一行片段拆成「字符 + 样式」单元;换行符保留为断行标记(宽度 0)。 */
function segmentUnits(segments: readonly StyledSegment[]): { char: string; codes: string; width: number }[] {
  const units: { char: string; codes: string; width: number }[] = [];
  for (const segment of segments) {
    for (const char of segment.text) {
      const width = codePointWidth(char.codePointAt(0) ?? 0);
      if (width === 0 && char !== '\n') {
        continue;
      }
      units.push({ char, codes: segment.codes, width });
    }
  }
  return units;
}

/** 把相邻同样式字符重新合并成片段,减少输出中的 SGR 切换。 */
function mergeUnits(units: readonly { char: string; codes: string }[]): StyledSegment[] {
  const segments: StyledSegment[] = [];
  for (const unit of units) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.codes === unit.codes) {
      last.text += unit.char;
    } else {
      segments.push({ text: unit.char, codes: unit.codes });
    }
  }
  return segments;
}

/**
 * 折行带样式的片段:断行规则与 wrapPlain 一致(空格优先、CJK 硬折),
 * 折行后各行的片段各自独立,渲染时不再跨界拼接。
 */
export function wrapStyled(segments: readonly StyledSegment[], width: number): StyledSegment[][] {
  if (width <= 0) {
    return [[]];
  }
  const units = segmentUnits(segments);
  const lines: StyledSegment[][] = [];
  let current: { char: string; codes: string; width: number }[] = [];
  let currentWidth = 0;
  let lastSpace = -1;
  const flush = (): void => {
    lines.push(mergeUnits(current));
    current = [];
    currentWidth = 0;
    lastSpace = -1;
  };
  for (const unit of units) {
    // 段内硬换行:立刻断行,不参与宽度计算
    if (unit.char === '\n') {
      flush();
      continue;
    }
    if (currentWidth + unit.width > width) {
      if (lastSpace >= 0 && lastSpace > 0) {
        const rest = current.slice(lastSpace + 1);
        current = current.slice(0, lastSpace);
        flush();
        current = rest;
        currentWidth = rest.reduce((sum, item) => sum + item.width, 0);
      } else {
        flush();
      }
    }
    current.push(unit);
    currentWidth += unit.width;
    if (unit.char === ' ') {
      lastSpace = current.length - 1;
    }
  }
  lines.push(mergeUnits(current));
  return lines;
}

/** 渲染一行片段为带 ANSI 的字符串。 */
export function renderStyledLine(line: readonly StyledSegment[]): string {
  return line.map((segment) => sgr(segment.codes, segment.text)).join('');
}

/** 一行片段的显示宽度。 */
export function styledLineWidth(line: readonly StyledSegment[]): number {
  let width = 0;
  for (const segment of line) {
    width += visibleWidth(segment.text);
  }
  return width;
}

/**
 * 把样式片段补齐或截断到指定显示宽度,返回渲染后的字符串:
 * 不足补空格保证右缘对齐(对齐方向可选),超出按显示宽度硬截并加省略号。
 */
export function fitStyledLine(
  line: readonly StyledSegment[],
  width: number,
  align: 'left' | 'center' | 'right' = 'left',
): string {
  const total = styledLineWidth(line);
  if (total <= width) {
    const rendered = renderStyledLine(line);
    const pad = width - total;
    if (align === 'right') {
      return ' '.repeat(pad) + rendered;
    }
    if (align === 'center') {
      const left = Math.floor(pad / 2);
      return ' '.repeat(left) + rendered + ' '.repeat(pad - left);
    }
    return rendered + ' '.repeat(pad);
  }
  const limit = Math.max(0, width - 1);
  let out = '';
  let used = 0;
  for (const segment of line) {
    if (used >= limit) {
      break;
    }
    let text = '';
    for (const char of segment.text) {
      const charWidth = codePointWidth(char.codePointAt(0) ?? 0);
      if (used + charWidth > limit) {
        break;
      }
      text += char;
      used += charWidth;
    }
    out += text === '' ? '' : sgr(segment.codes, text);
  }
  // CJK 步进为 2,截断点可能比 limit 少 1 列;补齐到精确宽度,表格边框才不会参差
  const result = `${out}…`;
  const pad = width - visibleWidth(result);
  return pad > 0 ? result + ' '.repeat(pad) : result;
}
