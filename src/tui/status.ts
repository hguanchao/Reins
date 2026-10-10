import { truncatePlain } from './layout.ts';
import type { Theme } from './theme.ts';

/**
 * 状态栏:输入框下方那一行,一眼回答「在哪、用什么模型、上下文还剩多少」。
 *
 * 设计意图:与 chrome 同样的纯函数思路——数据由应用层凑齐,这里只负责排版与
 * 数字缩写,便于单测。缺数据的项退化成 `—` 而不是消失,免得同一行在不同时刻
 * 一会儿有一会儿没有、看着像抖动;例外是分支与思考强度,不适用时整段省略。
 */

/** 状态栏的数据;拿不到的项留空。 */
export interface StatusBarInfo {
  /** 工作区目录名。 */
  project: string;
  /** 当前分支;不是 git 仓库时留空。 */
  branch?: string;
  /** 模型 id。 */
  model?: string;
  /** 思考强度;未配置时整段省略。 */
  reasoning?: string;
  /** 最近一轮的提示词 token 与模型上下文窗口。 */
  promptTokens?: number;
  contextWindow?: number;
  /** 缓存读取 token;端点不报缓存时留空。 */
  cacheReadTokens?: number;
}

/** 渲染状态栏:一行,按显示宽度截断。 */
export function renderStatusBar(width: number, theme: Theme, info: StatusBarInfo): string {
  const first = [`📁 ${info.project}`];
  if (info.branch !== undefined) {
    first.push(`🌿 ${info.branch}`);
  }
  const groups = [
    first.join(' · '),
    // 思考强度未配置就不占位:没显式配置的东西不在状态栏上占一格
    info.reasoning !== undefined
      ? `🤖 ${info.model ?? '—'} · 🧠 ${info.reasoning}`
      : `🤖 ${info.model ?? '—'}`,
    // 用量为 undefined 说明端点没回传 usage(0 由上层在「还没跑过」时给出),如实显示未知
    `📊 ${formatTokens(info.promptTokens)} / ${formatTokens(info.contextWindow)}`,
    `⚡ ${formatHitRate(info)}`,
  ];
  return theme.paint.muted(` ${truncatePlain(groups.join(' | '), Math.max(0, width - 2))}`);
}

/** 缓存命中率:缓存读 ÷ 提示词总量;端点不报缓存或总量为零时返回 undefined。 */
export function cacheHitRate(info: StatusBarInfo): number | undefined {
  const read = info.cacheReadTokens;
  const total = info.promptTokens;
  if (read === undefined || total === undefined || total <= 0) {
    return undefined;
  }
  // 个别端点会把缓存读也算进提示词总量,除出来略大于 1,显示上按 100% 封顶
  return Math.min(1, read / total);
}

function formatHitRate(info: StatusBarInfo): string {
  const rate = cacheHitRate(info);
  return rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * token 数按 1000 进制缩写:0 → 0.0K、14500 → 14.5K、128000 → 128K、1500000 → 1.5M。
 *
 * 小数只在看得见差别时保留:千位以内与十万以内留一位(0.0K 让空上下文也读得出
 * 「是 0」),十万到百万取整,到百万改用 M——再往上 K 的位数就不好读了。
 */
export function formatTokens(value: number | undefined): string {
  if (value === undefined) {
    return '—';
  }
  if (value < 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  if (value < 100_000) {
    return `${trimZero((value / 1000).toFixed(1))}K`;
  }
  if (value < 1_000_000) {
    const thousands = Math.round(value / 1000);
    // 四舍五入可能正好凑到 1000K,那就直接进位成 1M,别出现「1000K」这种读不顺的数
    return thousands < 1000 ? `${thousands}K` : '1M';
  }
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

/** 去掉小数末尾的 .0:1.0M 写作 1M。 */
function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}
