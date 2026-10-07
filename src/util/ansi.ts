/**
 * ANSI 转义:SGR 颜色规格的解析与包裹。
 *
 * 设计意图:放在 util 是因为 config(校验用户写的颜色)与 tui(应用颜色)
 * 都要用同一套语法;保持纯函数、零依赖,不认识任何业务概念。
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

/** 基础前景色名 → SGR 码;gray 归入亮黑(大多数终端下即"暗淡灰")。 */
const COLOR_NAMES: Readonly<Record<string, string>> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  grey: '90',
  brightblack: '90',
  brightred: '91',
  brightgreen: '92',
  brightyellow: '93',
  brightblue: '94',
  brightmagenta: '95',
  brightcyan: '96',
  brightwhite: '97',
  default: '39',
};

/** 样式修饰名 → SGR 码。 */
const MODIFIERS: Readonly<Record<string, string>> = {
  bold: '1',
  dim: '2',
  faint: '2',
  italic: '3',
  underline: '4',
  reverse: '7',
  strike: '9',
};

/** #rrggbb → 24bit 前景色 SGR 码;格式不对时返回 undefined。 */
function parseHex(token: string): string | undefined {
  const match = /^#([0-9a-fA-F]{6})$/.exec(token);
  if (match === null) {
    return undefined;
  }
  const hex = match[1] ?? '';
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `38;2;${red};${green};${blue}`;
}

/**
 * 解析颜色规格为 SGR 码串,例如 "bold cyan" → "1;36"、"#8ab4f8" → "38;2;…"、"200" → "38;5;200"。
 * 无法识别时返回 undefined,由调用方决定如何报错。
 */
export function parseSgrSpec(spec: string): string | undefined {
  const tokens = spec.trim().toLowerCase().split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) {
    return undefined;
  }
  const codes: string[] = [];
  for (const token of tokens) {
    const hex = parseHex(token);
    if (hex !== undefined) {
      codes.push(hex);
      continue;
    }
    if (/^\d{1,3}$/.test(token)) {
      const index = Number.parseInt(token, 10);
      if (index > 255) {
        return undefined;
      }
      codes.push(`38;5;${index}`);
      continue;
    }
    const modifier = MODIFIERS[token];
    if (modifier !== undefined) {
      codes.push(modifier);
      continue;
    }
    const color = COLOR_NAMES[token];
    if (color !== undefined) {
      codes.push(color);
      continue;
    }
    return undefined;
  }
  return codes.join(';');
}
