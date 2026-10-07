import { sgr } from '../util/ansi.ts';
import type { ThemePreset } from '../config/schema.ts';

/**
 * TUI 主题:角色化取色的唯一定义点。
 *
 * 设计意图:界面只按「角色」取色(品牌、成败、代码高亮……),不出现裸色号;
 * 颜色全局固定、不开放配置,预设决定各角色的取值,NO_COLOR 下整体退化为纯文本。
 */

/** 主题颜色角色:界面上唯一的一组取色点。 */
export type ThemeRole =
  | 'accent'
  | 'userBar'
  | 'ok'
  | 'warn'
  | 'fail'
  | 'muted'
  | 'heading'
  | 'quote'
  | 'code'
  | 'link'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type';

/** 各角色的默认颜色规格:dark 面向深色终端背景。 */
const DARK_PRESET: Readonly<Record<ThemeRole, string>> = {
  accent: '1;36',
  // 中性灰条带,前景一并给定:只设背景会跟着终端默认前景走,浅色终端上文字看不清
  userBar: '38;5;253;48;5;238',
  ok: '32',
  warn: '33',
  fail: '31',
  muted: '90',
  heading: '1;36',
  quote: '3;90',
  code: '96',
  link: '4;36',
  keyword: '1;35',
  string: '32',
  comment: '90',
  number: '33',
  function: '94',
  type: '96',
};

/** light 面向浅色背景:黄色系对比度差,统一改粗体或换主色;灰改淡(faint 自适应)。 */
const LIGHT_PRESET: Readonly<Record<ThemeRole, string>> = {
  accent: '1;34',
  userBar: '38;5;235;48;5;252',
  ok: '1;32',
  warn: '1;33',
  fail: '1;31',
  muted: '2',
  heading: '1;34',
  quote: '2;3',
  code: '34',
  link: '4;34',
  keyword: '1;35',
  string: '1;32',
  comment: '2',
  number: '1;33',
  function: '34',
  type: '36',
};

const PRESETS: Readonly<Record<ThemePreset, Readonly<Record<ThemeRole, string>>>> = {
  dark: DARK_PRESET,
  light: LIGHT_PRESET,
  mono: DARK_PRESET,
};

/** 默认环境判断:显式 NO_COLOR 或 dumb 终端不做任何上色。 */
function detectColor(): boolean {
  return process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';
}

export interface ThemeOptions {
  /** 预设名;省略 = dark。mono 强制纯文本。 */
  preset?: ThemePreset;
  /** 强制开/关颜色;省略 = 按 NO_COLOR 与 TERM 自动判断。 */
  color?: boolean;
}

export interface Theme {
  readonly name: ThemePreset;
  readonly useColor: boolean;
  /** 角色 → SGR 码串;供排版器按需合成(如粗体叠加角色色)。 */
  readonly codes: Readonly<Record<ThemeRole, string>>;
  /** 角色 → 上色函数;未启用颜色时为恒等。 */
  readonly paint: Readonly<Record<ThemeRole, (text: string) => string>>;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
}

/** 组装主题:预设打底,mono 或无色环境整体退化为纯文本。 */
export function createTheme(options: ThemeOptions = {}): Theme {
  const preset = options.preset ?? 'dark';
  const useColor = preset !== 'mono' && (options.color ?? detectColor());
  const defaults = PRESETS[preset] ?? DARK_PRESET;
  const codes = {} as Record<ThemeRole, string>;
  const paint = {} as Record<ThemeRole, (text: string) => string>;
  for (const role of Object.keys(defaults) as ThemeRole[]) {
    codes[role] = useColor ? defaults[role] : '';
    paint[role] = (text: string) => sgr(codes[role] ?? '', text);
  }
  const modifier = (code: string) => (text: string) => sgr(useColor ? code : '', text);
  return {
    name: preset,
    useColor,
    codes,
    paint,
    bold: modifier('1'),
    dim: modifier('2'),
    italic: modifier('3'),
    inverse: modifier('7'),
  };
}

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
