import { sgr } from '../util/ansi.ts';
import type { ThemePreset } from '../config/schema.ts';

/**
 * TUI 主题:角色化取色的唯一定义点。
 *
 * 设计意图:界面只按「角色」取色(品牌、成败、代码高亮……),不出现裸色号;
 * 颜色全局固定、不开放配置,预设决定各角色的取值,NO_COLOR 下整体退化为纯文本。
 *
 * 角色按「表面」分四组:基础色三个表面共用,其余三组各归一个表面。
 * 分组是为了让「改这一处会影响哪里」有明确归属——调 markdown 不该动到 TUI 的外观。
 */

/** 基础色:三个表面共用,不归任何单一表面。 */
export type BaseRole = 'muted' | 'ok' | 'warn' | 'fail';

/** TUI 配色:header、欢迎面板、补全菜单、输入框、用户消息条、分割线等界面镶边。 */
export type TuiRole =
  | 'accent'
  | 'userBar'
  | 'scrollbar'
  | 'completionBg'
  | 'completionBorder'
  | 'separator';

/** markdown 配色:正文排版(标题、行内代码、链接)。 */
export type MarkdownRole = 'heading' | 'code' | 'link';

/** 代码高亮配色:代码块内的语法分类。 */
export type HighlightRole = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type';

/** 全部角色:四组之并。 */
export type ThemeRole = BaseRole | TuiRole | MarkdownRole | HighlightRole;

// —— 取值说明 ——
//
// 全部使用 24 位真彩色(38;2;r;g;b),不再用基础 16 色:基础 16 色是终端自己的
// 调色板槽位,跟随终端主题但无法控制饱和度,默认配色普遍过艳。
// 色相只取中性灰/蓝/青/绿/琥珀/玫红/紫七种,饱和度压到约 25–35%;
// 承载文字的角色对其背景的对比度均 ≥ 4.5(WCAG AA),改动取值前请重新核对。
// 纯装饰性角色(separator、scrollbar、completionBg 等)不承载文字,不受此约束。

// —— dark:面向深色终端背景(对比度按 #1e1e1e 计算) ——

const DARK_BASE: Readonly<Record<BaseRole, string>> = {
  muted: '38;2;156;156;156', // #9c9c9c  6.07
  ok: '38;2;134;171;127', // #86ab7f  6.47
  warn: '38;2;198;173;120', // #c6ad78  7.66
  fail: '38;2;196;141;141', // #c48d8d  5.99
};

const DARK_USER_BAR_FOREGROUND = '220;220;220';
const DARK_USER_BAR_BACKGROUND = '36;36;36';
const DARK_COMPLETION_BACKGROUND = '36;36;36';
const DARK_COMPLETION_BORDER = '36;36;36';
const DARK_SEPARATOR = '36;36;36'; // #242424 分割线:刻意压暗,只作视觉分界

const DARK_TUI: Readonly<Record<TuiRole, string>> = {
  accent: '38;2;127;167;207', // #7fa7cf  6.61
  // 前景与背景一并给定:只设背景会跟着终端默认前景走,浅色终端上文字看不清
  userBar: `38;2;${DARK_USER_BAR_FOREGROUND};48;2;${DARK_USER_BAR_BACKGROUND}`, // #dcdcdc / #242424
  scrollbar: `38;2;${DARK_USER_BAR_BACKGROUND}`, // 与用户消息背景同色
  completionBg: `48;2;${DARK_COMPLETION_BACKGROUND}`, // #242424
  completionBorder: `38;2;${DARK_COMPLETION_BORDER}`, // #242424
  separator: `38;2;${DARK_SEPARATOR}`, // #242424
};

const DARK_MARKDOWN: Readonly<Record<MarkdownRole, string>> = {
  heading: '38;2;143;180;217', // #8fb4d9  7.70
  code: '38;2;127;174;174', // #7faeae  6.80
  link: '4;38;2;127;167;207', // #7fa7cf  6.61
};

const DARK_HIGHLIGHT: Readonly<Record<HighlightRole, string>> = {
  keyword: '38;2;176;140;196', // #b08cc4  5.87
  string: '38;2;134;171;127', // #86ab7f  6.47
  comment: '38;2;138;138;138', // #8a8a8a  4.83
  number: '38;2;198;173;120', // #c6ad78  7.66
  function: '38;2;127;167;207', // #7fa7cf  6.61
  type: '38;2;127;174;174', // #7faeae  6.80
};

// —— light:面向浅色背景(对比度按 #ffffff 计算) ——

const LIGHT_BASE: Readonly<Record<BaseRole, string>> = {
  muted: '38;2;95;95;95', // #5f5f5f  6.39
  ok: '38;2;79;122;72', // #4f7a48  4.99
  warn: '38;2;138;109;36', // #8a6d24  4.89
  fail: '38;2;163;79;79', // #a34f4f  5.54
};

// 浅色表面不能照抄深色取值:用户消息条与补全菜单若沿用 #242424 深底,浅色终端上
// 深底配深字几乎不可读,这里改用浅底 + 深字,并按浅底重新核对对比度
const LIGHT_USER_BAR_FOREGROUND = '43;43;43'; // #2b2b2b 深色字
const LIGHT_USER_BAR_BACKGROUND = '232;232;232'; // #e8e8e8 浅色底(对比度约 11.2)
const LIGHT_COMPLETION_BACKGROUND = '240;240;240'; // #f0f0f0
const LIGHT_COMPLETION_BORDER = '150;150;150'; // #969696 可见边框
const LIGHT_SCROLLBAR = '176;176;176'; // #b0b0b0 浅底上的滚动条
const LIGHT_SEPARATOR = '208;208;208'; // #d0d0d0 浅底上的分割线

const LIGHT_TUI: Readonly<Record<TuiRole, string>> = {
  accent: '38;2;63;107;156', // #3f6b9c  5.53
  userBar: `38;2;${LIGHT_USER_BAR_FOREGROUND};48;2;${LIGHT_USER_BAR_BACKGROUND}`, // #2b2b2b / #e8e8e8
  scrollbar: `38;2;${LIGHT_SCROLLBAR}`,
  completionBg: `48;2;${LIGHT_COMPLETION_BACKGROUND}`, // #f0f0f0
  completionBorder: `38;2;${LIGHT_COMPLETION_BORDER}`, // #969696
  separator: `38;2;${LIGHT_SEPARATOR}`, // #d0d0d0
};

const LIGHT_MARKDOWN: Readonly<Record<MarkdownRole, string>> = {
  heading: '38;2;53;96;143', // #35608f  6.52
  code: '38;2;63;112;112', // #3f7070  5.58
  link: '4;38;2;63;107;156', // #3f6b9c  5.53
};

const LIGHT_HIGHLIGHT: Readonly<Record<HighlightRole, string>> = {
  keyword: '38;2;122;79;150', // #7a4f96  6.20
  string: '38;2;79;122;72', // #4f7a48  4.99
  comment: '38;2;111;111;111', // #6f6f6f  5.02
  number: '38;2;138;109;36', // #8a6d24  4.89
  function: '38;2;63;107;156', // #3f6b9c  5.53
  type: '38;2;63;112;112', // #3f7070  5.58
};

/** 预设 = 四组合成;mono 复用 dark 取值,由 useColor 统一关闭上色。 */
const DARK_PRESET: Readonly<Record<ThemeRole, string>> = {
  ...DARK_BASE,
  ...DARK_TUI,
  ...DARK_MARKDOWN,
  ...DARK_HIGHLIGHT,
};

const LIGHT_PRESET: Readonly<Record<ThemeRole, string>> = {
  ...LIGHT_BASE,
  ...LIGHT_TUI,
  ...LIGHT_MARKDOWN,
  ...LIGHT_HIGHLIGHT,
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
    inverse: modifier('7'),
  };
}

export const symbols = {
  /** 运行中的旋转符帧。 */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
  tool: '⚙',
  // 成败标记用数学符号而非 dingbat(✓/✗):后者在部分字体里带 emoji 属性,
  // 会被渲染成彩色 emoji 或双宽字形,把行宽算错、撑破边框
  ok: '√',
  fail: '×',
  warn: '⚠',
  cursor: '▏',
  inputPrompt: '› ',
  separator: '─',
};
