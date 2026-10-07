import { highlightCode, type CodeToken } from './highlight.ts';
import {
  fitStyledLine,
  renderStyledLine,
  styledLineWidth,
  visibleWidth,
  wrapStyled,
  type StyledSegment,
} from './layout.ts';
import type { Theme } from './theme.ts';

/**
 * Markdown 渲染:把助手文本排成可读的终端版面。
 *
 * 设计意图:行内解析产出「字符 + 样式」片段,折行统一交给 layout;
 * 块级结构(标题/列表/引用/代码栅栏/表格)递归处理,流式输出中
 * 未闭合的栅栏按代码块渲染,不等到结束才排版。
 */

const INDENT = 2;

/** 渲染 markdown 文本为一组显示行;indent 为整体左缩进。 */
export function renderMarkdown(text: string, width: number, theme: Theme, indent = INDENT): string[] {
  const contentWidth = Math.max(8, width - indent);
  const body = renderBlocks(text, contentWidth, theme);
  return body.map((line) => (line === '' ? '' : `${' '.repeat(indent)}${line}`));
}

/** 分隔线:三个以上同类符号,允许空格相隔(---、***、___、* * *、- - - 等)。 */
function isThematicBreak(line: string): boolean {
  return /^\s*[-*_](?:[ \t]*[-*_]){2,}\s*$/.test(line);
}

/**
 * 是否是栅栏的闭合行:同种标记、不短于开启标记、且行内没有别的内容。
 * 只判前缀会让 ```md 里的 ```js 提前闭合,把后续代码块内容排成正文。
 */
function isClosingFence(line: string, marker: string): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  if (match === null) {
    return false;
  }
  const found = match[1] ?? '';
  return found[0] === marker[0] && found.length >= marker.length;
}

function renderBlocks(text: string, width: number, theme: Theme): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (fence !== null) {
      const marker = fence[2] ?? '';
      const lang = fence[3] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !isClosingFence(lines[index] ?? '', marker)) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      out.push(...renderCodeFence(code.join('\n'), lang, width, theme));
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '').length;
      // 深层标题只加粗不叠标题色,避免与 h1~h3 无法区分
      const codes = level <= 3 ? theme.codes.heading : theme.useColor ? '1' : '';
      out.push(...emitInline(heading[2] ?? '', width, theme, codes));
      index += 1;
      continue;
    }

    if (isThematicBreak(line)) {
      out.push(theme.paint.muted('─'.repeat(Math.min(width, 40))));
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      const inner = renderBlocks(quoted.join('\n'), width - 2, theme);
      for (const item of inner) {
        out.push(item === '' ? theme.paint.muted('▌') : `${theme.paint.muted('▌ ')}${item}`);
      }
      continue;
    }

    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem !== null) {
      const { block, consumed } = collectListItem(lines, index);
      out.push(...renderListItem(block, width, theme));
      index += consumed;
      continue;
    }

    if (/^\s*\|.*\|/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1] ?? '')) {
      const { table, align, consumed } = collectTable(lines, index);
      out.push(...renderTable(table, align, width, theme));
      index += consumed;
      continue;
    }

    if (line.trim() === '') {
      out.push('');
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !/^\s*(?:#{1,6}\s|>|`{3,}|~{3,}|[-*+]\s|\d+[.)]\s)/.test(lines[index] ?? '') &&
      !/^\s*\|.*\|\s*$/.test(lines[index] ?? '') &&
      !isThematicBreak(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    // 进度保证:行匹配了排除条件却不属于任何已知块时(典型:流式中
    // 表头行已到、分隔行未到),必须消费当前行,否则外层循环原地打转卡死
    if (paragraph.length === 0) {
      paragraph.push(line);
      index += 1;
    }
    out.push(...emitInline(paragraph.join('\n'), width, theme, ''));
  }
  return out;
}

/** 收集一个列表项:首行 + 更深缩进的续行/嵌套项,返回去缩进后的文本。 */
function collectListItem(
  lines: readonly string[],
  start: number,
): { block: { marker: string; ordered: boolean; text: string }; consumed: number } {
  const head = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[start] ?? '');
  const indent = (head?.[1] ?? '').length;
  const marker = head?.[2] ?? '';
  const ordered = /\d/.test(marker);
  // 正文起始列 = 缩进 + 标记宽度 + 空格;续行与嵌套都按它去缩进
  const contentOffset = indent + marker.length + 1;
  const body: string[] = [head?.[3] ?? ''];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      // 空行只有在其后仍是本项的深层缩进时才属于该项
      const next = lines[index + 1] ?? '';
      if (next.trim() !== '' && /^\s{2,}/.test(next) && (next.length - next.trimStart().length) > indent) {
        body.push('');
        index += 1;
        continue;
      }
      break;
    }
    const deeper = (line.length - line.trimStart().length) > indent;
    if (!deeper) {
      break;
    }
    body.push(line.slice(Math.min(contentOffset, line.length - line.trimStart().length)));
    index += 1;
  }
  return { block: { marker, ordered, text: body.join('\n') }, consumed: index - start };
}

function renderListItem(
  block: { marker: string; ordered: boolean; text: string },
  width: number,
  theme: Theme,
): string[] {
  // GFM 任务列表:未完成 □、已完成 ☑(完成态用成功色点一下)
  const checkbox = block.ordered ? null : /^\[( |x|X)\]\s+/.exec(block.text);
  const body = checkbox !== null ? block.text.slice(checkbox[0].length) : block.text;
  const bullet =
    checkbox !== null
      ? checkbox[1]?.toLowerCase() === 'x'
        ? `${theme.paint.ok('☑')} `
        : `${theme.paint.muted('□')} `
      : block.ordered
        ? `${block.marker} `
        : `${theme.paint.muted('•')} `;
  // 续行缩进跟随编号/符号实际宽度,多位编号(10. )才不会错位
  const bulletWidth = visibleWidth(bullet);
  const inner = renderBlocks(body, width - bulletWidth, theme);
  const out: string[] = [];
  inner.forEach((line, itemIndex) => {
    if (itemIndex === 0) {
      out.push(`${bullet}${line}`);
    } else if (line === '') {
      out.push('');
    } else {
      out.push(`${' '.repeat(bulletWidth)}${line}`);
    }
  });
  return out;
}

/** 单元格对齐方式,来自分隔行的冒号修饰。 */
export type TableCellAlign = 'left' | 'center' | 'right';

/** 收集一个 markdown 表格(含表头分隔行)。 */
function collectTable(
  lines: readonly string[],
  start: number,
): { table: string[][]; align: TableCellAlign[]; consumed: number } {
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && /^\s*\|.*\|?\s*$/.test(lines[index] ?? '')) {
    const line = (lines[index] ?? '').trim().replace(/^\|/, '').replace(/\|$/, '');
    rows.push(line.split('|').map((cell) => cell.trim()));
    index += 1;
  }
  let align: TableCellAlign[] = [];
  // 分隔行不参与内容;单横线与冒号修饰(:-、:-:、::---: 等)都算,并记录对齐语义
  if (rows.length >= 2 && rows[1]?.every((cell) => /^:?-+:?$/.test(cell)) === true) {
    align = (rows.splice(1, 1)[0] ?? []).map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) {
        return 'center';
      }
      return right ? 'right' : 'left';
    });
  }
  return { table: rows, align, consumed: index - start };
}

function renderTable(
  table: readonly (readonly string[])[],
  align: readonly TableCellAlign[],
  width: number,
  theme: Theme,
): string[] {
  if (table.length === 0) {
    return [];
  }
  const columns = Math.max(...table.map((row) => row.length));
  // 列宽按渲染后的实际内容宽计算:原始 markdown 里的 ** ` 等语法符与样式不影响宽度
  const measure = (cell: string): number =>
    styledLineWidth(parseInline(cell, '', theme));
  // 行宽预算:两端框线 6 列,列间 ' │ ' 各 3 列
  const budget = Math.max(columns * 4, width - 3 * columns - 3);
  const colWidth: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    let max = 0;
    for (const row of table) {
      max = Math.max(max, measure(row[column] ?? ''));
    }
    colWidth.push(Math.min(max, Math.max(4, Math.floor(budget / columns))));
  }
  const render = (rowIndex: number, codes: string): string[] => {
    const row = table[rowIndex] ?? [];
    // 单元格内容超出列宽时折行为多行,不截断丢内容;行高取本行最高的单元格
    const cellLines = Array.from({ length: columns }, (_, column) =>
      wrapStyled(parseInline(row[column] ?? '', codes, theme), colWidth[column] ?? 0),
    );
    const lineCount = Math.max(...cellLines.map((cell) => cell.length));
    const lines: string[] = [];
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      const cells = cellLines.map((cell, column) =>
        fitStyledLine(cell[lineIndex] ?? [], colWidth[column] ?? 0, align[column] ?? 'left'),
      );
      lines.push(`  ${theme.paint.muted('│')} ${cells.join(theme.paint.muted(' │ '))} ${theme.paint.muted('│')}`);
    }
    return lines;
  };
  // 全包边框:圆角与输入框一致;横线段比列宽多 2,
  // 正好吃掉数据行 ' │ ' 里的空格,┬ ┼ ┴ 与竖线逐列对准
  const frame = (left: string, middle: string, right: string): string =>
    `  ${theme.paint.muted(left)}${colWidth
      .map((columnWidth) => theme.paint.muted('─'.repeat(columnWidth + 2)))
      .join(theme.paint.muted(middle))}${theme.paint.muted(right)}`;
  const out: string[] = [frame('╭', '┬', '╮')];
  out.push(...render(0, theme.codes.heading));
  out.push(frame('├', '┼', '┤'));
  for (let index = 1; index < table.length; index += 1) {
    out.push(...render(index, ''));
  }
  out.push(frame('╰', '┴', '╯'));
  return out;
}

/** 代码块相对正文再退两格:分界交给缩进与配色。 */
const CODE_INSET = 2;

/**
 * 代码栅栏:语法高亮 + 缩进分界,不画边框也不铺背景。
 *
 * 边框会把 `│ ` 一起复制进剪贴板,铺背景又与 dark / light / mono 三档配色和用户
 * 自己的终端底色打架;代码与正文的分界靠缩进加高亮已经足够。长行仍需预折——
 * 整屏差分渲染要求行数恒定,但续行只用空格补齐,不放任何标记字符。
 */
function renderCodeFence(code: string, lang: string, width: number, theme: Theme): string[] {
  const indent = ' '.repeat(CODE_INSET);
  const lineWidth = Math.max(8, width - CODE_INSET);
  const out: string[] = [];
  for (const tokens of highlightCode(code, lang)) {
    for (const segments of wrapStyled(tokensToSegments(tokens, theme), lineWidth)) {
      out.push(`${indent}${renderStyledLine(segments)}`);
    }
  }
  return out;
}

function tokensToSegments(tokens: readonly CodeToken[], theme: Theme): StyledSegment[] {
  return tokens.map((token) => ({
    text: token.text,
    codes: token.role === undefined ? '' : (theme.codes[token.role] ?? ''),
  }));
}

/** 行内解析并折行为最终显示行。 */
function emitInline(
  text: string,
  width: number,
  theme: Theme,
  baseCodes: string,
): string[] {
  const segments = parseInline(text, baseCodes, theme);
  return wrapStyled(segments, width).map((line) => renderStyledLine(line));
}

/** 行内解析:代码 span、粗体、斜体、删除线、链接与裸链接。 */
export function parseInline(text: string, baseCodes: string, theme: Theme): StyledSegment[] {
  // 无色主题下修饰码一并省去,与角色取色的退化行为一致
  const modifier = (codes: string): string => (theme.useColor ? codes : '');
  const segments: StyledSegment[] = [];
  let plain = '';
  let index = 0;

  const flush = (): void => {
    if (plain !== '') {
      segments.push({ text: plain, codes: baseCodes });
      plain = '';
    }
  };
  const push = (text_: string, codes: string): void => {
    flush();
    segments.push({ text: text_, codes });
  };

  while (index < text.length) {
    const rest = text.slice(index);

    if (rest.startsWith('\n')) {
      plain += '\n';
      index += 1;
      continue;
    }
    if (rest.startsWith('\\') && rest.length > 1) {
      plain += rest[1] ?? '';
      index += 2;
      continue;
    }
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code !== null) {
      push(code[1] ?? '', theme.codes.code);
      index += (code[0] ?? '').length;
      continue;
    }
    const boldItalic = /^\*\*\*([^*\n]+)\*\*\*/.exec(rest);
    if (boldItalic !== null) {
      push(boldItalic[1] ?? '', mergeCodes(baseCodes, modifier('1;3')));
      index += (boldItalic[0] ?? '').length;
      continue;
    }
    // 粗体只认 **:__ 与 __init__、__main__ 这类双下划线标识符冲突太狠,不作为语法
    const bold = /^\*\*([^*\n]+)\*\*/.exec(rest);
    if (bold !== null) {
      push(bold[1] ?? '', mergeCodes(baseCodes, modifier('1')));
      index += (bold[0] ?? '').length;
      continue;
    }
    const strike = /^~~([^~\n]+)~~/.exec(rest);
    if (strike !== null) {
      push(strike[1] ?? '', mergeCodes(baseCodes, modifier('9')));
      index += (strike[0] ?? '').length;
      continue;
    }
    // 单星号总是斜体;下划线斜体要求两侧都是词边界(不能贴着字母/数字/下划线),
    // 否则 my_var_ 这类残缺标识符会被吃进去
    const italicStar = /^\*([^*\n]+)\*/.exec(rest);
    const italicUnder = /^_(?!_)([^_\n]+)_(?![\p{L}\p{N}_])/u.exec(rest);
    const prevChar = index > 0 ? (text[index - 1] ?? '') : '';
    const italic =
      italicStar ??
      (italicUnder !== null && !/[\p{L}\p{N}_]/u.test(prevChar) ? italicUnder : null);
    if (italic !== null) {
      push(italic[1] ?? '', mergeCodes(baseCodes, modifier('3')));
      index += (italic[0] ?? '').length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link !== null) {
      const label = link[1] ?? '';
      const url = link[2] ?? '';
      push(label, theme.codes.link);
      if (url !== label) {
        segments.push({ text: ` (${url})`, codes: theme.codes.muted });
      }
      index += (link[0] ?? '').length;
      continue;
    }
    const autolink = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
    if (autolink !== null) {
      // 尖括号自动链接:括号本身不是内容
      push(autolink[1] ?? '', theme.codes.link);
      index += (autolink[0] ?? '').length;
      continue;
    }
    const url = /(https?:\/\/[^\s<>()[\]]+)/.exec(rest);
    if (url !== null && (url.index ?? 0) === 0) {
      // URL 边界:首个非 ASCII 字符起即是正文——中文句读不属于链接,
      // URL 里的非 ASCII 本应百分号编码
      const raw = url[1] ?? '';
      const cut = /[\u0080-\uffff]/.exec(raw);
      const matched = cut === null ? raw : raw.slice(0, cut.index ?? 0);
      if (matched !== '') {
        push(matched, theme.codes.link);
        index += matched.length;
        continue;
      }
    }
    plain += rest[0] ?? '';
    index += 1;
  }
  flush();
  return segments;
}

/** 合并 SGR 码串:去重拼接;任一为空时直接返回另一个。 */
function mergeCodes(base: string, add: string): string {
  if (base === '') {
    return add;
  }
  if (add === '') {
    return base;
  }
  const existing = new Set(base.split(';'));
  const extra = add.split(';').filter((code) => !existing.has(code));
  return extra.length === 0 ? base : `${base};${extra.join(';')}`;
}
