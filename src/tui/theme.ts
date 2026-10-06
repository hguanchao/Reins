/**
 * TUI 主题:颜色与符号的唯一定义点。
 *
 * 设计意图:淡品牌色——青(品牌/用户)、琥珀(审批/警告)、绿/红(成败)、灰(次要);
 * NO_COLOR 或非彩色终端下自动退化为纯文本。
 */

const useColor = process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';

/** 用 SGR 包裹文本;未启用颜色时原样返回。 */
export function sgr(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const paint = {
  cyan: (text: string) => sgr('36', text),
  cyanBold: (text: string) => sgr('1;36', text),
  amber: (text: string) => sgr('33', text),
  green: (text: string) => sgr('32', text),
  red: (text: string) => sgr('31', text),
  gray: (text: string) => sgr('90', text),
  bold: (text: string) => sgr('1', text),
  dim: (text: string) => sgr('2', text),
  inverse: (text: string) => sgr('7', text),
};

export const symbols = {
  /** 运行中的旋转符帧。 */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
  tool: '⚙',
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  cursor: '▏',
  inputPrompt: '› ',
  separator: '─',
};
