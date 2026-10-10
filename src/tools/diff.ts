/**
 * 紧凑行差异:只给「改了什么」,不给完整 diff。
 *
 * 设计意图:编辑工具是精确文本替换,改动往往集中在几行,而工具结果既要进模型
 * 上下文、又要画到界面上,所以这里只保留共同前后缀之外的那一段,并限制行数。
 * 不是通用 diff(没有 LCS 与移动检测),换来的是一条结果几十个 token 就能读完。
 */

/** 差异行:前缀 ' ' 为上下文、'-' 为删除、'+' 为新增。 */
export type DiffLine = { kind: 'context' | 'remove' | 'add'; text: string };

/** 差异行的显示前缀。 */
export const DIFF_MARK: Readonly<Record<DiffLine['kind'], string>> = {
  context: ' ',
  remove: '-',
  add: '+',
};

/**
 * 计算 before → after 的紧凑差异。
 *
 * 先剥掉相同的行首、行尾,中间不同的部分整段列为删除与新增;两侧各留 context 行
 * 上下文,便于看清改动落在哪。行数超过 maxLines 时中间省略,并把总行数带回去。
 */
export function lineDiff(
  before: string,
  after: string,
  options: { context?: number; maxLines?: number } = {},
): DiffLine[] {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 12;
  const left = splitLines(before);
  const right = splitLines(after);

  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }

  const lines: DiffLine[] = [];
  for (const text of left.slice(Math.max(0, head - context), head)) {
    lines.push({ kind: 'context', text });
  }
  for (const text of left.slice(head, left.length - tail)) {
    lines.push({ kind: 'remove', text });
  }
  for (const text of right.slice(head, right.length - tail)) {
    lines.push({ kind: 'add', text });
  }
  for (const text of right.slice(right.length - tail, right.length - tail + context)) {
    lines.push({ kind: 'context', text });
  }

  if (lines.length <= maxLines) {
    return lines;
  }
  // 中间省略:保留头尾各一半,省略量由调用方按总数说明
  const half = Math.floor((maxLines - 1) / 2);
  return [
    ...lines.slice(0, half),
    { kind: 'context', text: `… 省略 ${lines.length - maxLines + 1} 行 …` },
    ...lines.slice(lines.length - (maxLines - 1 - half)),
  ];
}

/** 按行切开;末尾换行不产生空行,便于比较。 */
function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** 把差异行渲染成可直接放进工具结果的文本。 */
export function formatDiff(lines: readonly DiffLine[]): string {
  return lines.map((line) => `${DIFF_MARK[line.kind]}${line.text}`).join('\n');
}
