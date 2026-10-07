/**
 * ANSI 转义:SGR 序列的包裹与剥离。
 *
 * 设计意图:保持纯函数、零依赖,不认识任何业务概念,供 tui 排版层复用。
 */

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** 去掉文本中的 SGR 样式序列。 */
export function stripSgr(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** 用 SGR 序列包裹文本;codes 为空时原样返回(无色环境)。 */
export function sgr(codes: string, text: string): string {
  return codes === '' ? text : `\u001b[${codes}m${text}\u001b[0m`;
}
