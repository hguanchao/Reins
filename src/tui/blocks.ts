import {
  paintRow,
  truncateAnsi,
  truncatePlain,
  visibleWidth,
  wrapPlain,
} from './layout.ts';
import { renderMarkdown } from './markdown.ts';
import { symbols, type Theme } from './theme.ts';
import { VERSION } from '../util/version.ts';

/**
 * 滚动区块模型:对话历史的唯一数据结构。
 *
 * 设计意图:每个区块自带渲染结果(纯函数),状态由上层事件驱动;
 * 渲染只依赖区块自身与宽度/主题,便于测试;工具输出默认折叠成一行,
 * 展开后给出预览,完整内容交给全屏查看器。
 */

export type ToolState = 'running' | 'ok' | 'fail';
export type NoticeLevel = 'info' | 'warn' | 'error';

export type ScrollBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | {
      kind: 'tool';
      name: string;
      summary: string;
      state: ToolState;
      elapsedMs?: number;
      detail?: string;
      /** 完整工具输出;折叠时不渲染,展开/查看器使用。 */
      output?: string;
      /** 是否展开预览输出。 */
      expanded?: boolean;
    }
  | { kind: 'notice'; text: string; level: NoticeLevel }
  | { kind: 'welcome' };

export interface RenderContext {
  spinner: string;
  theme: Theme;
}

/** 展开时最多预览的输出行数;再多交给全屏查看器。 */
const PREVIEW_LINES = 10;

/** 把工具参数 JSON 压成一行摘要:优先常见键,否则取第一个字符串值。 */
export function summarizeToolArgs(argumentsJson: string): string {
  const compact = (text: string): string => text.replace(/\s+/g, ' ').trim();
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return compact(argumentsJson);
    }
    const record = parsed as Record<string, unknown>;
    for (const key of ['command', 'path', 'pattern', 'url', 'query', 'server', 'name']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return compact(value);
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim() !== '') {
        return compact(value);
      }
    }
    return compact(argumentsJson);
  } catch {
    return compact(argumentsJson);
  }
}

/** 耗时格式化:0.1s 精度。 */
export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 渲染单个区块为若干显示行(含 ANSI 样式)。 */
export function renderBlock(block: ScrollBlock, width: number, context: RenderContext): string[] {
  switch (block.kind) {
    case 'user':
      return renderUser(block.text, width, context.theme);
    case 'assistant':
      return renderAssistant(block, width, context.theme);
    case 'tool':
      return renderTool(block, width, context);
    case 'notice':
      return renderNotice(block, width, context.theme);
    case 'welcome':
      return renderWelcome(width, context.theme);
  }
}

/** 全屏查看器用的完整渲染:工具块输出全部展开,其余与普通渲染一致。 */
export function renderBlockVerbose(block: ScrollBlock, width: number, context: RenderContext): string[] {
  if (block.kind !== 'tool') {
    return renderBlock(block, width, context);
  }
  const theme = context.theme;
  const lines = [renderToolHead(block, width, context)];
  const body = toolOutputLines(block, width - 4, theme);
  if (body.length === 0) {
    lines.push(`    ${theme.paint.muted('(无输出)')}`);
  }
  lines.push(...body);
  return lines;
}

/** 助手正文的左缩进:与用户消息正文、工具块共用同一条左边界。 */
const ASSISTANT_INDENT = 2;

/** 用户消息条:整行中性灰,前缀 › 取强调色,上下各留一行空白条带,不标注角色。 */
function renderUser(text: string, width: number, theme: Theme): string[] {
  const prefix = '› ';
  const prefixWidth = visibleWidth(prefix);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const raw = text === '' ? [''] : wrapPlain(text, bodyWidth);
  const body = raw.map((line, index) => {
    const head = index === 0 ? theme.paint.accent(prefix) : ' '.repeat(prefixWidth);
    return paintRow(`${head}${line}`, width, theme.codes.userBar);
  });
  // 上下各补一行空白条带:消息条有厚度,不贴着文字
  const blank = paintRow('', width, theme.codes.userBar);
  return [blank, ...body, blank];
}

function renderAssistant(block: { text: string }, width: number, theme: Theme): string[] {
  // 正文左缩进与用户消息正文对齐,不标注角色
  return renderMarkdown(block.text, width, theme, ASSISTANT_INDENT);
}

function renderTool(
  block: { name: string; summary: string; state: ToolState; elapsedMs?: number; detail?: string; output?: string; expanded?: boolean },
  width: number,
  context: RenderContext,
): string[] {
  const theme = context.theme;
  const lines = [renderToolHead(block, width, context)];
  const output = toolOutputLines(block, width - 4, theme);
  if (block.expanded === true && output.length > 0) {
    const preview = output.slice(0, PREVIEW_LINES);
    lines.push(...preview);
    if (output.length > PREVIEW_LINES) {
      lines.push(`    ${theme.paint.muted(`… 共 ${output.length} 行 · Ctrl+O 全屏查看`)}`);
    }
  } else if (block.detail !== undefined && block.detail !== '') {
    const detail = truncatePlain(block.detail, Math.max(0, width - 8));
    lines.push(`    ${block.state === 'fail' ? theme.paint.fail(`↳ ${detail}`) : theme.paint.muted(`↳ ${detail}`)}`);
  }
  return lines;
}

function renderToolHead(
  block: { name: string; summary: string; state: ToolState; elapsedMs?: number; output?: string },
  width: number,
  context: RenderContext,
): string {
  const theme = context.theme;
  const statusPlain =
    block.state === 'running'
      ? `${context.spinner} 运行中…`
      : `${block.state === 'ok' ? symbols.ok : symbols.fail}${
          block.elapsedMs !== undefined ? ` ${formatElapsed(block.elapsedMs)}` : ''
        }`;
  const status =
    block.state === 'running'
      ? theme.paint.warn(statusPlain)
      : block.state === 'ok'
        ? theme.paint.ok(statusPlain)
        : theme.paint.fail(statusPlain);

  let summaryText = block.summary;
  if (summaryText !== '') {
    const allow = width - visibleWidth(`  ${symbols.tool} ${block.name}`) - 2 - visibleWidth(statusPlain) - 2;
    summaryText = allow > 4 ? truncatePlain(summaryText, allow) : '';
  }
  const line = `${theme.paint.muted(`  ${symbols.tool}`)} ${theme.bold(block.name)}${
    summaryText === '' ? '' : `  ${theme.paint.muted(summaryText)}`
  }  ${status}`;
  const head = `  ${symbols.tool} ${block.name}`;
  return visibleWidth(head) + 2 + visibleWidth(statusPlain) > width ? truncateAnsi(line, width) : line;
}

/** 工具输出的显示行:原样换行,不附加样式(内容本身可读性优先)。 */
function toolOutputLines(
  block: { output?: string },
  width: number,
  _theme: Theme,
): string[] {
  if (block.output === undefined || block.output === '') {
    return [];
  }
  const lines: string[] = [];
  for (const raw of block.output.split('\n')) {
    const wrapped = wrapPlain(raw, Math.max(8, width));
    for (const line of wrapped) {
      lines.push(line === '' ? '' : `    ${line}`);
    }
  }
  return lines;
}

function renderNotice(
  block: { text: string; level: NoticeLevel },
  width: number,
  theme: Theme,
): string[] {
  const prefix = block.level === 'info' ? '·' : block.level === 'warn' ? symbols.warn : symbols.fail;
  const color = block.level === 'info' ? theme.paint.muted : block.level === 'warn' ? theme.paint.warn : theme.paint.fail;
  const body = wrapPlain(block.text, Math.max(1, width - 4));
  return body.map((line, index) => `  ${color(index === 0 ? `${prefix} ${line}` : `  ${line}`)}`);
}

/** 品牌名与一句话定位:欢迎页只留这两行,其余信息各有固定去处(命令见 /help,状态见 /status)。 */
const BRAND = 'Reins';
const BRAND_DESC = '可控优先的编程智能体';

/**
 * 哪些通知会让欢迎页退场:警告与错误意味着环境需要用户处理,
 * 欢迎语继续占屏会把注意力从问题上引开;info 属轻量回执,不打扰。
 */
export function noticeDismissesWelcome(level: NoticeLevel): boolean {
  return level === 'warn' || level === 'error';
}

function renderWelcome(width: number, theme: Theme): string[] {
  // 两行都居中且同取灰:欢迎页是启动时唯一占屏的东西,不该比它介绍的家伙更抢眼
  return [
    centerLine(`${BRAND} v${VERSION}`, width, theme.paint.muted),
    centerLine(BRAND_DESC, width, theme.paint.muted),
  ];
}

/** 信任页上的一行覆盖项。 */
export interface TrustPageRow {
  label: string;
  detail: string;
}

/** 按显示宽度把一行居中。 */
function centerLine(text: string, width: number, style?: (value: string) => string): string {
  const plain = truncatePlain(text, width);
  const pad = Math.max(0, Math.floor((width - visibleWidth(plain)) / 2));
  return ' '.repeat(pad) + (style !== undefined ? style(plain) : plain);
}

/** 按显示宽度右补空格,用于两列对齐(CJK 占两格,靠字符串长度对不齐)。 */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * 信任页:居中提问 + 目录路径 + 会被采纳的内容。
 *
 * 会被采纳的内容分两块:项目层对全局配置的覆盖(逐条给「改成什么」),
 * 以及会被读进系统提示词的说明文件。都为空时如实说明——按下 y 之前应当
 * 看得见自己在信任什么,而不是靠一句通用风险警告。
 */
export function renderTrustPage(
  width: number,
  theme: Theme,
  input: { path: string; overrides: readonly TrustPageRow[]; docs: readonly string[] },
): string[] {
  const lines: string[] = [];
  lines.push(centerLine('信任这个目录吗?', width, theme.paint.accent));
  lines.push('');
  lines.push(centerLine(input.path, width, theme.paint.muted));
  lines.push('');

  const entries: string[] = [];
  if (input.overrides.length > 0) {
    entries.push('覆盖全局配置:');
    // 两列对齐:标签按最宽的补齐,再统一缩进到清单块内
    const labelWidth = input.overrides.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0);
    for (const row of input.overrides) {
      entries.push(`  ${padDisplay(row.label, labelWidth + 2)}${row.detail}`);
    }
  }
  if (input.docs.length > 0) {
    if (entries.length > 0) {
      entries.push('');
    }
    // 说明文件与标签同一行,不逐个换行
    entries.push(`注入项目说明文件: ${input.docs.join('、')}`);
  }
  if (entries.length === 0) {
    entries.push('(该目录没有项目层配置,也没有说明文件)');
  }

  // 清单整块居中:先算最宽行,再把每行推同样数量的空格
  const blockWidth = entries.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
  const indent = ' '.repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
  for (const row of entries) {
    lines.push(indent + truncatePlain(row, Math.max(0, width - indent.length)));
  }
  return lines;
}

/**
 * 带缓存的区块渲染器。
 *
 * 历史区块全部留在内存里,但渲染行只保留视口附近的:滚出屏幕的区块只留行数,
 * 滚回来时按需重渲染。这样每帧的工作量与占用都只跟视口相关,不随对话长度增长。
 */
export interface BlockRenderer {
  /** 取区块的渲染行(必要时渲染并缓存)。 */
  render(block: ScrollBlock, width: number): string[];
  /** 取区块的行数;缓存里有行数就直接用,不必保留渲染行。 */
  height(block: ScrollBlock, width: number): number;
  /** 回收渲染行:keep 之外的区块只留行数,已不在 blocks 中的条目整条删除。 */
  release(blocks: readonly ScrollBlock[], keep: readonly ScrollBlock[]): void;
}

/** 缓存条目:行被回收后 lines 为 null,此时只有行数可信。 */
interface CachedBlock {
  stamp: string;
  lines: string[] | null;
  height: number;
}

export function createBlockRenderer(context: RenderContext): BlockRenderer {
  const cache = new Map<ScrollBlock, CachedBlock>();

  const render = (block: ScrollBlock, width: number): string[] => {
    const stamp = cacheStamp(block, width, context);
    const hit = cache.get(block);
    if (hit !== undefined && hit.stamp === stamp && hit.lines !== null) {
      return hit.lines;
    }
    const lines = renderBlock(block, width, context);
    cache.set(block, { stamp, lines, height: lines.length });
    return lines;
  };

  return {
    render,
    height(block, width) {
      const hit = cache.get(block);
      if (hit !== undefined && hit.stamp === cacheStamp(block, width, context)) {
        return hit.height;
      }
      return render(block, width).length;
    },
    release(blocks, keep) {
      const alive = new Set(blocks);
      const live = new Set(keep);
      for (const [block, entry] of cache) {
        if (!alive.has(block)) {
          cache.delete(block);
        } else if (!live.has(block) && entry.lines !== null) {
          cache.set(block, { stamp: entry.stamp, lines: null, height: entry.height });
        }
      }
    },
  };
}

/**
 * 整段内容的行数:各区块行数之和,外加区块之间的空行。
 *
 * 空行的规则与物化时一致——已有内容才空行,否则开头的空区块会白占一行。
 */
export function contentHeight(heights: readonly number[]): number {
  let total = 0;
  for (const height of heights) {
    if (total > 0) {
      total += 1;
    }
    total += height;
  }
  return total;
}

/** 视口窗口:需要物化的区块区间与头部裁切量。 */
export interface ScrollWindow {
  /** 首个需要物化的区块下标;无区块时为 0。 */
  start: number;
  /** 最后一个需要物化的区块下标(含);无区块时为 -1。 */
  end: number;
  /** 整段内容的行数。 */
  total: number;
  /** 需从物化结果头部裁掉的行数,使首行恰好落在视口顶端。 */
  skip: number;
}

/** 各区块首行在整段内容中的偏移(含区块之间的空行)。 */
function blockOffsets(heights: readonly number[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const height of heights) {
    if (cursor > 0) {
      cursor += 1;
    }
    offsets.push(cursor);
    cursor += height;
  }
  return offsets;
}

/**
 * 计算视口命中的区块范围。
 *
 * 区块占用的范围含它后面那条空行(空区块因此也可能占一行),这样按范围判断
 * 「哪一行由谁画」不会漏掉空行,start 也就自然跳过开头的空区块。
 */
export function scrollWindow(
  heights: readonly number[],
  top: number,
  viewHeight: number,
): ScrollWindow {
  const total = contentHeight(heights);
  if (heights.length === 0) {
    return { start: 0, end: -1, total, skip: 0 };
  }
  const offsets = blockOffsets(heights);
  const bottom = top + Math.max(0, viewHeight);

  let start = heights.length - 1;
  for (let index = 0; index < heights.length; index += 1) {
    const regionEnd = index + 1 < heights.length ? (offsets[index + 1] as number) : total;
    if (regionEnd > top) {
      start = index;
      break;
    }
  }
  let end = start;
  for (let index = heights.length - 1; index > start; index -= 1) {
    if ((offsets[index] as number) < bottom) {
      end = index;
      break;
    }
  }
  return { start, end, total, skip: Math.max(0, top - (offsets[start] as number)) };
}

/**
 * 物化窗口内的区块:按整段内容的排版拼接(区块之间空一行),再裁掉头部偏移。
 *
 * 返回行数可能少于视口高度(内容到底了),由调用方补白。
 */
export function renderWindow(
  blocks: readonly ScrollBlock[],
  window: ScrollWindow,
  render: (block: ScrollBlock) => string[],
): string[] {
  const lines: string[] = [];
  for (let index = window.start; index <= window.end; index += 1) {
    const block = blocks[index];
    if (block === undefined) {
      continue;
    }
    // 窗口首块之前那条空行属于上一个区块的范围,不在这里补
    if (index > window.start) {
      lines.push('');
    }
    lines.push(...render(block));
  }
  return window.skip === 0 ? lines : lines.slice(window.skip);
}

/** 缓存键:覆盖所有会影响渲染结果的输入。 */
function cacheStamp(block: ScrollBlock, width: number, context: RenderContext): string {
  const base = `${width}|${context.theme.name}|${context.theme.useColor}`;
  switch (block.kind) {
    case 'user':
      return `${base}|u|${block.text}`;
    case 'assistant':
      return `${base}|a|${block.text.length}|${block.text.slice(-80)}`;
    case 'tool':
      return `${base}|t|${block.state}|${block.elapsedMs ?? ''}|${block.expanded === true}|${
        block.output?.length ?? 0
      }|${block.detail ?? ''}|${block.state === 'running' ? context.spinner : ''}`;
    case 'notice':
      return `${base}|n|${block.level}|${block.text}`;
    case 'welcome':
      return `${base}|w|`;
  }
}
